//! Custom model providers: endpoints a person adds once and any kernel that speaks their API may use.
//!
//! A provider is kept in the settings, except its API key, which is kept apart in the store so it never lands in a
//! settings revision or a page. The first time the settings have no provider list, Oh My Pi's own custom providers
//! (its `models.yml`) are imported once as the starting list.

use crate::settings::Kernel;
use neo_store::Store;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// The APIs a provider may speak, with what each kernel makes of them.
pub const APIS: &[&str] = &["openai-completions", "openai-responses", "anthropic-messages"];

/// Whether a kernel can use a provider of an API. Oh My Pi speaks every API it knows; Hermes the OpenAI and Anthropic
/// ones; Claude Code only Anthropic's; the Antigravity CLI uses no custom providers.
pub fn serves(kernel: Kernel, api: &str) -> bool {
    match kernel {
        Kernel::Omp => !api.is_empty(),
        Kernel::Hermes => APIS.contains(&api),
        Kernel::Claude => api == "anthropic-messages",
        Kernel::Antigravity => false,
    }
}

/// The kernels that can use a provider of an API.
pub fn kernels_serving(api: &str) -> Vec<Kernel> {
    [Kernel::Omp, Kernel::Claude, Kernel::Antigravity, Kernel::Hermes].into_iter().filter(|kernel| serves(*kernel, api)).collect()
}

/// A model a provider serves.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    /// The id the endpoint knows it by.
    pub id: String,
    /// A display name; the id when empty.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    /// Whether it thinks before answering.
    #[serde(default)]
    pub reasoning: bool,
    /// Whether it takes images.
    #[serde(default)]
    pub images: bool,
    /// Its context window, in tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// The most tokens it writes in one answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    /// Further Oh My Pi model fields kept as imported, such as `thinking`, `cost` or `compat`.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

/// An endpoint and the models it serves.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Provider {
    /// The name models are chosen by, as `<name>/<model id>`.
    pub name: String,
    /// One of [`APIS`], or another API Oh My Pi knows.
    pub api: String,
    /// The endpoint, such as `https://example.com/v1`.
    pub base_url: String,
    /// Headers sent with every request.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    /// The models it serves.
    #[serde(default)]
    pub models: Vec<ProviderModel>,
    /// The kernels that use it.
    #[serde(default)]
    pub kernels: Vec<Kernel>,
    /// Further Oh My Pi provider fields kept as imported, such as `compat` or `authHeader`.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

impl Provider {
    /// Trim what people type, and drop the kernels its API does not serve.
    pub fn normalize(&mut self) {
        self.name = self.name.trim().to_string();
        self.api = self.api.trim().to_string();
        self.base_url = self.base_url.trim().trim_end_matches('/').to_string();
        self.headers = std::mem::take(&mut self.headers).into_iter().map(|(name, value)| (name.trim().to_string(), value.trim().to_string())).collect();
        for model in &mut self.models {
            model.id = model.id.trim().to_string();
            model.name = model.name.trim().to_string();
        }
        let api = self.api.clone();
        let mut seen = BTreeSet::new();
        self.kernels.retain(|kernel| serves(*kernel, &api) && seen.insert(*kernel));
    }

    /// Whether a kernel uses it.
    pub fn used_by(&self, kernel: Kernel) -> bool {
        self.kernels.contains(&kernel) && serves(kernel, &self.api)
    }

    /// Whether requests carry the key as `Authorization: Bearer`, rather than the API's own header.
    fn bearer(&self) -> bool {
        self.extra.get("authHeader").and_then(Value::as_bool).unwrap_or(false)
    }
}

/// Check a provider list; the first problem is returned in words.
pub fn validate(providers: &[Provider]) -> Result<(), String> {
    let mut names = BTreeSet::new();
    for provider in providers {
        let name = &provider.name;
        let named = (1..=64).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'));
        if !named {
            return Err(format!("Provider name {name:?} must be 1 to 64 letters, digits, _, - or ."));
        }
        if !names.insert(name.to_ascii_lowercase()) {
            return Err(format!("Duplicate provider {name}"));
        }
        if provider.api.is_empty() || provider.api.len() > 64 {
            return Err(format!("Provider {name} needs an API"));
        }
        if !(provider.base_url.starts_with("http://") || provider.base_url.starts_with("https://")) || provider.base_url.len() > 2000 {
            return Err(format!("Provider {name} needs a base URL starting with http:// or https://"));
        }
        for (header, value) in &provider.headers {
            let token = !header.is_empty() && header.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'));
            if !token || value.contains(['\r', '\n']) {
                return Err(format!("Provider {name} has an invalid header {header:?}"));
            }
        }
        let mut ids = BTreeSet::new();
        for model in &provider.models {
            if model.id.is_empty() || model.id.len() > 200 || model.id.chars().any(char::is_whitespace) {
                return Err(format!("Provider {name} has a model id that is empty, too long or has spaces"));
            }
            if !ids.insert(model.id.as_str()) {
                return Err(format!("Provider {name} lists model {} twice", model.id));
            }
        }
        if let Some(kernel) = provider.kernels.iter().find(|kernel| !serves(**kernel, &provider.api)) {
            return Err(format!("The {} kernel cannot use a provider of API {}", kernel.as_str(), provider.api));
        }
    }
    Ok(())
}

const KEY: &str = "provider-key:";

/// The providers' API keys, kept apart from the settings. A key may also name an environment variable that holds it,
/// as in Oh My Pi's `models.yml`.
pub struct ProviderKeys<'a>(pub &'a Store);

impl ProviderKeys<'_> {
    /// A provider's key as saved.
    pub fn get(&self, provider: &str) -> Option<String> {
        self.0.get::<String>(&format!("{KEY}{}", provider.to_ascii_lowercase())).filter(|key| !key.is_empty())
    }
    /// Save a provider's key, or forget it with `None`.
    pub fn set(&self, provider: &str, key: Option<&str>) {
        let name = format!("{KEY}{}", provider.to_ascii_lowercase());
        match key.map(str::trim).filter(|key| !key.is_empty()) {
            Some(key) => self.0.set(&name, &key.to_string()),
            None => self.0.delete(&name),
        }
    }
    /// Forget the keys of providers no longer listed.
    pub fn keep_only(&self, providers: &[Provider]) {
        let kept: BTreeSet<String> = providers.iter().map(|provider| format!("{KEY}{}", provider.name.to_ascii_lowercase())).collect();
        for name in self.0.keys(KEY) {
            if !kept.contains(&name) {
                self.0.delete(&name);
            }
        }
    }
}

/// What a saved key stands for: the value of the environment variable it names, else itself.
pub fn resolve_key(saved: &str) -> String {
    let variable =
        saved.bytes().next().is_some_and(|b| b.is_ascii_uppercase()) && saved.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_');
    match variable.then(|| std::env::var(saved).ok()).flatten().filter(|value| !value.is_empty()) {
        Some(value) => value,
        None => saved.to_string(),
    }
}

/// How a saved key shows on a page: whether there is one, and a hint that does not give it away.
pub fn key_hint(saved: Option<&str>) -> Option<String> {
    let saved = saved?;
    let variable = saved.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_');
    if variable {
        return Some(format!("${saved}"));
    }
    let tail: String = saved.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    Some(if saved.chars().count() > 8 { format!("…{tail}") } else { "••••".into() })
}

/// A provider with its key resolved, as a kernel needs it.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedProvider {
    /// The provider.
    pub provider: Provider,
    /// Its key; `None` for an endpoint that takes none.
    pub key: Option<String>,
}

/// The variable that hands a kernel the custom providers it uses.
pub const PROVIDERS_VARIABLE: &str = "NEO_PROVIDERS";

/// The variables that hand a kernel the providers it uses: [`PROVIDERS_VARIABLE`] lists them in Oh My Pi's shape,
/// each key in a variable of its own that the list names as `apiKeyEnv`, so no key is written to a file.
pub fn runtime_env(kernel: Kernel, providers: &[ResolvedProvider]) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    let mut listed = Vec::new();
    for (index, resolved) in providers.iter().filter(|resolved| resolved.provider.used_by(kernel)).enumerate() {
        let provider = &resolved.provider;
        let mut entry = provider.extra.clone();
        entry.insert("name".into(), json!(provider.name));
        entry.insert("api".into(), json!(provider.api));
        entry.insert("baseUrl".into(), json!(provider.base_url));
        if !provider.headers.is_empty() {
            entry.insert("headers".into(), json!(provider.headers));
        }
        if let Some(key) = &resolved.key {
            let variable = format!("NEO_PROVIDER_KEY_{index}");
            env.insert(variable.clone(), key.clone());
            entry.insert("apiKeyEnv".into(), json!(variable));
        }
        let models: Vec<Value> = provider
            .models
            .iter()
            .map(|model| {
                let mut item = model.extra.clone();
                item.insert("id".into(), json!(model.id));
                item.insert("name".into(), json!(if model.name.is_empty() { &model.id } else { &model.name }));
                item.insert("reasoning".into(), json!(model.reasoning));
                item.insert("input".into(), json!(if model.images { vec!["text", "image"] } else { vec!["text"] }));
                if let Some(window) = model.context_window {
                    item.insert("contextWindow".into(), json!(window));
                }
                if let Some(most) = model.max_tokens {
                    item.insert("maxTokens".into(), json!(most));
                }
                Value::Object(item)
            })
            .collect();
        entry.insert("models".into(), json!(models));
        listed.push(Value::Object(entry));
    }
    if !listed.is_empty() {
        env.insert(PROVIDERS_VARIABLE.into(), Value::Array(listed).to_string());
    }
    env
}

/// The variables that point Claude Code at a custom provider for one model: its endpoint, its key and its headers,
/// with every model tier mapped to the chosen one so background calls do not ask the endpoint for a model it lacks.
/// The second list is the variables to remove, so a login of the user's own does not go along.
pub fn claude_env(resolved: &ResolvedProvider, model: &str) -> (BTreeMap<String, String>, Vec<String>) {
    let provider = &resolved.provider;
    let mut env = BTreeMap::from([("ANTHROPIC_BASE_URL".to_string(), provider.base_url.trim_end_matches("/v1").to_string())]);
    let key = resolved.key.clone().unwrap_or_else(|| "neo-no-key".into());
    let (set, unset) = if provider.bearer() { ("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY") } else { ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN") };
    env.insert(set.into(), key);
    for tier in [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
    ] {
        env.insert(tier.into(), model.to_string());
    }
    if !provider.headers.is_empty() {
        env.insert("ANTHROPIC_CUSTOM_HEADERS".into(), provider.headers.iter().map(|(name, value)| format!("{name}: {value}")).collect::<Vec<_>>().join("\n"));
    }
    (env, vec![unset.to_string(), "CLAUDE_CODE_OAUTH_TOKEN".into(), "CLAUDE_CODE_USE_BEDROCK".into(), "CLAUDE_CODE_USE_VERTEX".into()])
}

/// Whether a provider of an API lists its models over the API itself, so nobody has to type them.
pub fn lists_models(api: &str) -> bool {
    APIS.contains(&api)
}

/// The request for one page of a provider's model list: `GET <base>/models` for the OpenAI APIs, and Anthropic's
/// `GET /v1/models`, paged after a model id.
pub fn models_request(resolved: &ResolvedProvider, after: Option<&str>) -> Option<crate::http::Request> {
    let provider = &resolved.provider;
    let base = provider.base_url.trim_end_matches('/');
    let mut headers: Vec<(String, String)> = provider.headers.iter().map(|(name, value)| (name.clone(), value.clone())).collect();
    let url = match provider.api.as_str() {
        "openai-completions" | "openai-responses" => {
            if let Some(key) = &resolved.key {
                headers.push(("authorization".into(), format!("Bearer {key}")));
            }
            format!("{base}/models")
        }
        "anthropic-messages" => {
            headers.push(("anthropic-version".into(), "2023-06-01".into()));
            if let Some(key) = &resolved.key {
                headers.push(if provider.bearer() { ("authorization".into(), format!("Bearer {key}")) } else { ("x-api-key".into(), key.clone()) });
            }
            let root = base.strip_suffix("/v1").unwrap_or(base);
            match after {
                Some(id) => format!("{root}/v1/models?limit=1000&after_id={id}"),
                None => format!("{root}/v1/models?limit=1000"),
            }
        }
        _ => return None,
    };
    Some(crate::http::Request { method: "GET", url, headers, body: None, timeout: std::time::Duration::from_secs(20), want: Vec::new() })
}

/// The models in one page of a model list, and the id to page after when there are more. Besides the id, what an
/// entry says of its name, context window, longest answer, image input and thinking is kept.
pub fn parse_models(body: &Value) -> (Vec<ProviderModel>, Option<String>) {
    let entries = body.get("data").or_else(|| body.get("models")).and_then(Value::as_array).cloned().unwrap_or_default();
    let number = |entry: &Value, fields: &[&str]| fields.iter().find_map(|field| entry.pointer(field).and_then(Value::as_u64)).filter(|value| *value > 0);
    let models: Vec<ProviderModel> = entries
        .iter()
        .filter_map(|entry| {
            let id = entry.get("id").and_then(Value::as_str).map(str::trim).filter(|id| !id.is_empty() && !id.contains(char::is_whitespace))?.to_string();
            let name = ["/display_name", "/name"].iter().find_map(|field| entry.pointer(field).and_then(Value::as_str)).unwrap_or_default().trim().to_string();
            let inputs =
                ["/modalities/input", "/architecture/input_modalities", "/input"].iter().find_map(|field| entry.pointer(field).and_then(Value::as_array));
            let levels: Vec<Value> = entry.get("reasoning_levels").and_then(Value::as_array).cloned().unwrap_or_default();
            let reasoning = entry.get("reasoning").and_then(Value::as_bool).unwrap_or(false)
                || !levels.is_empty()
                || entry
                    .get("supported_parameters")
                    .and_then(Value::as_array)
                    .is_some_and(|parameters| parameters.iter().any(|parameter| parameter == "reasoning"));
            let mut extra = Map::new();
            if !levels.is_empty() {
                extra.insert("thinking".into(), json!({"mode": "effort", "efforts": levels}));
            }
            Some(ProviderModel {
                name: if name == id { String::new() } else { name },
                reasoning,
                images: inputs.is_some_and(|inputs| inputs.iter().any(|kind| kind == "image")),
                context_window: number(entry, &["/context_window", "/context_length", "/max_input_tokens", "/top_provider/context_length"]),
                max_tokens: number(entry, &["/max_output_tokens", "/max_completion_tokens", "/max_tokens", "/top_provider/max_completion_tokens"]),
                id,
                extra,
            })
        })
        .collect();
    let more = body.get("has_more").and_then(Value::as_bool).unwrap_or(false);
    let next = more.then(|| body.get("last_id").and_then(Value::as_str).map(str::to_string).or_else(|| models.last().map(|model| model.id.clone()))).flatten();
    (models, next)
}

/// The listed models, each keeping what was known of it before: what was set by hand or imported comes first, and
/// the list fills in the rest. A model the endpoint no longer lists is dropped.
pub fn merge_models(before: &[ProviderModel], listed: Vec<ProviderModel>) -> Vec<ProviderModel> {
    let mut seen = BTreeSet::new();
    listed
        .into_iter()
        .filter(|model| seen.insert(model.id.clone()))
        .map(|found| match before.iter().find(|known| known.id == found.id) {
            Some(known) => {
                let mut extra = found.extra;
                extra.extend(known.extra.clone());
                ProviderModel {
                    name: if known.name.is_empty() { found.name } else { known.name.clone() },
                    reasoning: known.reasoning || found.reasoning,
                    images: known.images || found.images,
                    context_window: known.context_window.or(found.context_window),
                    max_tokens: known.max_tokens.or(found.max_tokens),
                    id: found.id,
                    extra,
                }
            }
            None => found,
        })
        .collect()
}

/// Ask a provider for its models over its own API.
pub async fn discover(resolved: &ResolvedProvider) -> Result<Vec<ProviderModel>, String> {
    let name = &resolved.provider.name;
    let mut found = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..20 {
        let request = models_request(resolved, after.as_deref())
            .ok_or_else(|| format!("{name}: its API ({}) lists no models; enter them by hand", resolved.provider.api))?;
        let response = crate::http::send(request).await.map_err(|failure| format!("{name}: cannot list models: {failure}"))?;
        if response.status != 200 {
            let text = String::from_utf8_lossy(&response.body);
            let text: String = text.chars().take(300).collect();
            return Err(format!("{name}: listing models answered {}: {}", response.status, text.trim()));
        }
        let body: Value = serde_json::from_slice(&response.body).map_err(|_| format!("{name}: the model list is not JSON"))?;
        let (page, next) = parse_models(&body);
        found.extend(page);
        match next {
            Some(id) if Some(&id) != after.as_ref() => after = Some(id),
            _ => break,
        }
    }
    if found.is_empty() {
        return Err(format!("{name}: the endpoint lists no models"));
    }
    Ok(found)
}

/// Oh My Pi's custom providers in its `models.yml`, each with the key it names: those that define an endpoint and
/// models. Providers that only adjust a built-in one are left out. A file that is missing or unreadable gives none.
pub fn import_omp(models_yml: &Path) -> Vec<(Provider, Option<String>)> {
    let Ok(text) = std::fs::read_to_string(models_yml) else { return Vec::new() };
    let Ok(document) = serde_yaml_ng::from_str::<Value>(&text) else { return Vec::new() };
    let Some(providers) = document.get("providers").and_then(Value::as_object) else { return Vec::new() };
    let mut imported = Vec::new();
    for (name, config) in providers {
        let Some(config) = config.as_object() else { continue };
        let Some(base_url) = config.get("baseUrl").and_then(Value::as_str) else { continue };
        let models: Vec<&Map<String, Value>> = config.get("models").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_object).collect();
        let first_api = models.iter().find_map(|model| model.get("api").and_then(Value::as_str));
        let api = config.get("api").and_then(Value::as_str).or(first_api).unwrap_or("openai-completions").to_string();
        let models: Vec<ProviderModel> = models
            .into_iter()
            .filter_map(|model| {
                let id = model.get("id")?.as_str()?.to_string();
                let mut extra = model.clone();
                for field in ["id", "name", "reasoning", "input", "contextWindow", "maxTokens"] {
                    extra.remove(field);
                }
                Some(ProviderModel {
                    name: model.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
                    reasoning: model.get("reasoning").and_then(Value::as_bool).unwrap_or(false),
                    images: model.get("input").and_then(Value::as_array).is_some_and(|input| input.iter().any(|kind| kind == "image")),
                    context_window: model.get("contextWindow").and_then(Value::as_u64),
                    max_tokens: model.get("maxTokens").and_then(Value::as_u64),
                    id,
                    extra,
                })
            })
            .collect();
        if models.is_empty() {
            continue;
        }
        let headers = config
            .get("headers")
            .and_then(Value::as_object)
            .map(|headers| headers.iter().filter_map(|(name, value)| Some((name.clone(), value.as_str()?.to_string()))).collect())
            .unwrap_or_default();
        let mut extra = config.clone();
        for field in ["api", "auth", "baseUrl", "apiKey", "headers", "models"] {
            extra.remove(field);
        }
        let key =
            (config.get("auth").and_then(Value::as_str) != Some("none")).then(|| config.get("apiKey").and_then(Value::as_str).map(str::to_string)).flatten();
        let mut provider = Provider { name: name.clone(), kernels: kernels_serving(&api), api, base_url: base_url.to_string(), headers, models, extra };
        provider.normalize();
        if validate(std::slice::from_ref(&provider)).is_ok() {
            imported.push((provider, key));
        }
    }
    imported
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(name: &str, api: &str) -> Provider {
        Provider {
            name: name.into(),
            api: api.into(),
            base_url: "http://127.0.0.1:9/v1".into(),
            headers: BTreeMap::new(),
            models: vec![ProviderModel {
                id: "m".into(),
                name: String::new(),
                reasoning: false,
                images: false,
                context_window: None,
                max_tokens: None,
                extra: Map::new(),
            }],
            kernels: kernels_serving(api),
            extra: Map::new(),
        }
    }

    #[test]
    fn each_kernel_takes_the_apis_it_speaks() {
        assert_eq!(kernels_serving("openai-completions"), vec![Kernel::Omp, Kernel::Hermes]);
        assert_eq!(kernels_serving("anthropic-messages"), vec![Kernel::Omp, Kernel::Claude, Kernel::Hermes]);
        assert_eq!(kernels_serving("google-generative-ai"), vec![Kernel::Omp]);
    }

    #[test]
    fn refuses_bad_providers_in_words() {
        let refused = |providers: Vec<Provider>| validate(&providers).unwrap_err();
        assert!(refused(vec![provider("a b", "openai-completions")]).contains("Provider name"));
        assert!(refused(vec![provider("a", "openai-completions"), provider("A", "openai-responses")]).contains("Duplicate"));
        let mut bad = provider("a", "openai-completions");
        bad.base_url = "ftp://x".into();
        assert!(refused(vec![bad]).contains("base URL"));
        let mut bad = provider("a", "openai-completions");
        bad.kernels.push(Kernel::Claude);
        assert!(refused(vec![bad.clone()]).contains("claude"));
        bad.normalize();
        assert_eq!(bad.kernels, vec![Kernel::Omp, Kernel::Hermes]);
        validate(&[bad]).unwrap();
    }

    #[test]
    fn imports_omp_custom_providers_and_their_keys() {
        let dir = std::env::temp_dir().join(format!("neo-providers-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("models.yml");
        std::fs::write(
            &file,
            "providers:\n  local:\n    api: openai-completions\n    auth: none\n    baseUrl: http://127.0.0.1:8080/v1/\n    headers:\n      User-Agent: omp\n    compat:\n      x: 1\n    models:\n      - id: big\n        name: Big\n        reasoning: true\n        input: [text, image]\n        contextWindow: 1000\n        thinking:\n          mode: effort\n  keyed:\n    api: anthropic-messages\n    baseUrl: https://example.com\n    apiKey: EXAMPLE_KEY\n    models:\n      - id: m\n  tweak:\n    modelOverrides: {}\n",
        )
        .unwrap();
        let imported = import_omp(&file);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(
            imported.iter().map(|(provider, key)| (provider.name.as_str(), key.as_deref())).collect::<Vec<_>>(),
            vec![("keyed", Some("EXAMPLE_KEY")), ("local", None)]
        );
        let local = &imported[1].0;
        assert_eq!(local.base_url, "http://127.0.0.1:8080/v1");
        assert_eq!(local.kernels, vec![Kernel::Omp, Kernel::Hermes]);
        assert_eq!(local.extra.get("compat"), Some(&json!({"x": 1})));
        let big = &local.models[0];
        assert_eq!((big.reasoning, big.images, big.context_window, big.extra.get("thinking")), (true, true, Some(1000), Some(&json!({"mode": "effort"}))));
        assert_eq!(imported[0].0.kernels, vec![Kernel::Omp, Kernel::Claude, Kernel::Hermes]);
        assert!(import_omp(Path::new("/nonexistent/models.yml")).is_empty());
    }

    #[test]
    fn hands_each_kernel_only_its_providers_with_keys_in_variables() {
        let providers = vec![
            ResolvedProvider { provider: provider("open", "openai-completions"), key: Some("secret".into()) },
            ResolvedProvider { provider: provider("anth", "anthropic-messages"), key: None },
        ];
        let env = runtime_env(Kernel::Omp, &providers);
        let listed: Value = serde_json::from_str(&env[PROVIDERS_VARIABLE]).unwrap();
        assert_eq!(listed[0]["apiKeyEnv"], "NEO_PROVIDER_KEY_0");
        assert_eq!(env["NEO_PROVIDER_KEY_0"], "secret");
        assert!(!env[PROVIDERS_VARIABLE].contains("secret"));
        assert!(listed[1].get("apiKeyEnv").is_none());
        assert_eq!(listed[0]["models"][0], json!({"id": "m", "name": "m", "reasoning": false, "input": ["text"]}));
        assert!(runtime_env(Kernel::Antigravity, &providers).is_empty());
        let (env, unset) = claude_env(&providers[1], "m");
        assert_eq!(
            (env["ANTHROPIC_BASE_URL"].as_str(), env["ANTHROPIC_API_KEY"].as_str(), env["ANTHROPIC_DEFAULT_HAIKU_MODEL"].as_str()),
            ("http://127.0.0.1:9", "neo-no-key", "m")
        );
        assert!(unset.contains(&"ANTHROPIC_AUTH_TOKEN".to_string()));
    }

    #[test]
    fn reads_model_lists_of_each_api_and_keeps_what_was_known() {
        let openai = json!({"object": "list", "data": [
            {"id": "group/intent", "display_name": "Intent", "context_window": 1000, "max_output_tokens": 50, "modalities": {"input": ["text", "image"]}, "reasoning_levels": ["low", "high"]},
            {"id": "plain"},
            {"id": "bad id"}
        ], "has_more": false});
        let (models, next) = parse_models(&openai);
        assert_eq!(next, None);
        assert_eq!(models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), vec!["group/intent", "plain"]);
        let intent = &models[0];
        assert_eq!(
            (intent.name.as_str(), intent.context_window, intent.max_tokens, intent.images, intent.reasoning),
            ("Intent", Some(1000), Some(50), true, true)
        );
        assert_eq!(intent.extra["thinking"], json!({"mode": "effort", "efforts": ["low", "high"]}));
        let anthropic = json!({"data": [{"id": "claude-x", "display_name": "Claude X", "type": "model"}], "has_more": true, "last_id": "claude-x"});
        assert_eq!(parse_models(&anthropic).1.as_deref(), Some("claude-x"));
        // What was known wins; the list fills gaps and decides which models there are.
        let mut known = provider("p", "openai-completions").models[0].clone();
        known.id = "group/intent".into();
        known.max_tokens = Some(128);
        known.extra.insert("cost".into(), json!({"input": 1}));
        let merged = merge_models(&[known], models);
        assert_eq!((merged[0].max_tokens, merged[0].context_window, merged[0].name.as_str()), (Some(128), Some(1000), "Intent"));
        assert!(merged[0].extra.contains_key("cost") && merged[0].extra.contains_key("thinking"));
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn asks_each_api_for_its_models_its_own_way() {
        let mut resolved = ResolvedProvider { provider: provider("p", "openai-responses"), key: Some("k".into()) };
        let request = models_request(&resolved, None).unwrap();
        assert_eq!(request.url, "http://127.0.0.1:9/v1/models");
        assert!(request.headers.contains(&("authorization".into(), "Bearer k".into())));
        resolved.provider.api = "anthropic-messages".into();
        let request = models_request(&resolved, Some("last")).unwrap();
        assert_eq!(request.url, "http://127.0.0.1:9/v1/models?limit=1000&after_id=last");
        assert!(request.headers.contains(&("x-api-key".into(), "k".into())));
        resolved.provider.api = "google-generative-ai".into();
        assert!(models_request(&resolved, None).is_none());
    }

    #[test]
    fn keys_resolve_variables_and_show_only_a_hint() {
        assert_eq!(resolve_key("sk-literal"), "sk-literal");
        assert_eq!(resolve_key("NEO_SURELY_UNSET_VARIABLE"), "NEO_SURELY_UNSET_VARIABLE");
        assert_eq!(key_hint(Some("OPENAI_API_KEY")).as_deref(), Some("$OPENAI_API_KEY"));
        assert_eq!(key_hint(Some("sk-abcdefghijkl")).as_deref(), Some("…ijkl"));
        assert_eq!(key_hint(Some("short")).as_deref(), Some("••••"));
        let store = Store::memory();
        let keys = ProviderKeys(&store);
        keys.set("Open", Some(" k "));
        assert_eq!(keys.get("open").as_deref(), Some("k"));
        keys.keep_only(&[]);
        assert_eq!(keys.get("open"), None);
    }
}
