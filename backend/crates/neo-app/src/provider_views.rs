//! The custom provider settings: listing, saving and importing them, and handing them to the kernels.

use crate::app::App;
use crate::providers::{self, key_hint, resolve_key, Provider, ProviderKeys, ResolvedProvider, APIS};
use crate::settings::Kernel;
use crate::views::object;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

impl App {
    /// Hand the kernels the custom providers in the settings, with their keys, and forget the models they listed
    /// before, so the next list shows the change.
    pub(crate) fn apply_providers(&self) {
        self.kernels.set_providers(self.resolved_providers());
        self.model_lists.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clear();
    }

    /// The custom providers with their keys.
    fn resolved_providers(&self) -> Vec<ResolvedProvider> {
        let keys = ProviderKeys(&self.store);
        self.settings()
            .provider_list()
            .iter()
            .map(|provider| ResolvedProvider { key: keys.get(&provider.name).map(|key| resolve_key(&key)), provider: provider.clone() })
            .collect()
    }

    /// Ask providers for their models over their own APIs, all at once, and keep what they list: those `named`, or
    /// every provider whose API lists its models. A provider that cannot be asked keeps the models it had, and says
    /// why on the page.
    pub(crate) async fn refresh_provider_models(self: &Arc<Self>, named: Option<Vec<String>>) {
        let mut asks = tokio::task::JoinSet::new();
        for resolved in self.resolved_providers() {
            let wanted = named.as_ref().is_none_or(|names| names.contains(&resolved.provider.name));
            if wanted && providers::lists_models(&resolved.provider.api) {
                asks.spawn(async move { (resolved.provider.name.clone(), providers::discover(&resolved).await) });
            }
        }
        let mut outcomes = BTreeMap::new();
        while let Some(done) = asks.join_next().await {
            if let Ok((name, listed)) = done {
                outcomes.insert(name, listed);
            }
        }
        if outcomes.is_empty() {
            return;
        }
        // Only the models change, of the providers as they are now, so an edit made meanwhile stays.
        let mut next = (*self.settings()).clone();
        let mut problems = self.provider_problems.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        for provider in next.providers.iter_mut().flatten() {
            match outcomes.remove(&provider.name) {
                Some(Ok(listed)) => {
                    provider.models = providers::merge_models(&provider.models, listed);
                    problems.remove(&provider.name);
                }
                Some(Err(problem)) => {
                    problems.insert(provider.name.clone(), problem);
                }
                None => {}
            }
        }
        drop(problems);
        if next != *self.settings() && self.save_settings(next, "internal", "providers").is_ok() {
            self.apply_providers();
        }
    }

    /// Start from Oh My Pi's custom providers the first time the settings have none, then hand them to the kernels
    /// and ask them for their models in the background.
    pub(crate) fn start_providers(self: &Arc<Self>) -> Result<(), String> {
        if self.settings().providers.is_none() {
            let imported = self.kernels.imported_providers();
            let keys = ProviderKeys(&self.store);
            for (provider, key) in &imported {
                keys.set(&provider.name, key.as_deref());
            }
            let mut next = (*self.settings()).clone();
            next.providers = Some(imported.into_iter().map(|(provider, _)| provider).collect());
            self.save_settings(next, "internal", "providers")?;
        }
        self.apply_providers();
        let app = Arc::clone(self);
        tokio::spawn(async move { app.refresh_provider_models(None).await });
        Ok(())
    }

    /// Ask every provider for its models now.
    pub async fn refresh_providers(self: &Arc<Self>) -> Result<Value, String> {
        self.refresh_provider_models(None).await;
        Ok(self.providers_view())
    }

    /// The custom providers, each key shown only as a hint, with the APIs a provider may speak and the ones each
    /// kernel can use (`*` for any).
    pub fn providers_view(&self) -> Value {
        let keys = ProviderKeys(&self.store);
        let problems = self.provider_problems.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
        let listed: Vec<Value> = self
            .settings()
            .provider_list()
            .iter()
            .map(|provider| {
                let mut item = serde_json::to_value(provider).unwrap_or_default();
                item["key"] = json!(key_hint(keys.get(&provider.name).as_deref()));
                item["listsModels"] = json!(providers::lists_models(&provider.api));
                item["modelsProblem"] = json!(problems.get(&provider.name));
                item
            })
            .collect();
        let serves: Map<String, Value> = [Kernel::Omp, Kernel::Claude, Kernel::Antigravity, Kernel::Hermes]
            .into_iter()
            .map(|kernel| {
                let apis = if kernel == Kernel::Omp { json!("*") } else { json!(APIS.iter().filter(|api| providers::serves(kernel, api)).collect::<Vec<_>>()) };
                (kernel.as_str().to_string(), apis)
            })
            .collect();
        json!({"providers": listed, "apis": APIS, "serves": serves})
    }

    /// Replace the custom providers with `providers`. Each may carry `apiKey`: a key or the name of a variable that
    /// holds one, `null` or empty to take none, absent to keep the one it had; and `previousName`, when it was
    /// renamed, so its key goes along. Everything is checked before anything is saved; a provider's kernels default
    /// to every kernel that can use it.
    pub async fn update_providers(self: &Arc<Self>, value: Value) -> Result<Value, String> {
        let fields = object(value, &["providers"])?;
        let Some(Value::Array(items)) = fields.get("providers").cloned() else { return Err("providers must be a list".into()) };
        let keys = ProviderKeys(&self.store);
        let mut list = Vec::new();
        let mut chosen = Vec::new();
        let mut items_with_key = Vec::new();
        for item in items {
            let Value::Object(mut item) = item else { return Err("Each provider is a JSON object".into()) };
            let key = item.remove("apiKey");
            let previous = item.remove("previousName").and_then(|name| name.as_str().map(str::to_string));
            item.remove("key");
            let defaults_kernels = !item.contains_key("kernels");
            let mut provider: Provider = serde_json::from_value(Value::Object(item)).map_err(|error| format!("Invalid provider: {error}"))?;
            if defaults_kernels {
                provider.kernels = providers::kernels_serving(provider.api.trim());
            }
            provider.normalize();
            if key.is_some() {
                items_with_key.push(provider.name.clone());
            }
            let key = match key {
                Some(Value::String(key)) => Some(key),
                Some(Value::Null) => None,
                Some(_) => return Err(format!("The key of provider {} must be text or null", provider.name)),
                None => keys.get(previous.as_deref().unwrap_or(&provider.name)),
            };
            chosen.push((provider.name.clone(), key));
            list.push(provider);
        }
        providers::validate(&list)?;
        // A provider that is new, or reached another way, is asked for its models once saved.
        let before = self.settings().provider_list().to_vec();
        let ask: Vec<String> = list
            .iter()
            .filter(|provider| {
                items_with_key.contains(&provider.name)
                    || provider.models.is_empty()
                    || !before.iter().any(|known| {
                        known.name == provider.name && known.api == provider.api && known.base_url == provider.base_url && known.headers == provider.headers
                    })
            })
            .map(|provider| provider.name.clone())
            .collect();
        let mut next = (*self.settings()).clone();
        next.providers = Some(list);
        self.save_settings(next, "app", "providers")?;
        self.store.atomic(|| {
            for (name, key) in &chosen {
                keys.set(name, key.as_deref());
            }
            keys.keep_only(self.settings().provider_list());
            Ok::<(), String>(())
        })?;
        self.apply_providers();
        if !ask.is_empty() {
            self.refresh_provider_models(Some(ask)).await;
        }
        Ok(self.providers_view())
    }

    /// Add Oh My Pi's custom providers that are not listed yet, by name, with their keys.
    pub async fn import_providers(self: &Arc<Self>) -> Result<Value, String> {
        let mut list = self.settings().provider_list().to_vec();
        let keys = ProviderKeys(&self.store);
        let mut added = Vec::new();
        for (provider, key) in self.kernels.imported_providers() {
            if !list.iter().any(|known| known.name.eq_ignore_ascii_case(&provider.name)) {
                added.push((provider.name.clone(), key));
                list.push(provider);
            }
        }
        if !added.is_empty() {
            let mut next = (*self.settings()).clone();
            next.providers = Some(list);
            self.save_settings(next, "app", "providers")?;
            for (name, key) in &added {
                keys.set(name, key.as_deref());
            }
            self.apply_providers();
            self.refresh_provider_models(Some(added.iter().map(|(name, _)| name.clone()).collect())).await;
        }
        let mut view = self.providers_view();
        view["imported"] = json!(added.len());
        Ok(view)
    }
}
