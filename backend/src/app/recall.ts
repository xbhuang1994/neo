//! Zero-dependency, noise-resistant historical ticket search and dual-channel candidate recall engine.
//!
//! Features:
//! - Environment-driven rollout flags (`recallConfig()`, never written to persistent `Settings`)
//! - Untrusted text sanitization & Neo template stripping (`<attachment>`, `FILES_ALONE`, voice/quote markers)
//! - Atomic compound numeral & version extraction (prevents "二十万" from sliding into "十万")
//! - Mutual-exclusion numeric conflict detection & penalty (`×0.45`) with human-readable `conflict_signals`
//! - Boundary-safe Chinese/English hybrid tokenization (`Intl.Segmenter("zh-CN")` + OOV 2-gram + identifier split)
//! - Multi-field saturated scoring with smoothed IDF, dynamic DF suppression, status/artifact priors, and time cap
//! - Two decoupled query channels:
//!   - `recallForCandidate`: precision-first passive recall for candidate cards (never returns `matched_snippet`)
//!   - `search`: recall-first active `orchestrator_search` with explainability and 48h `same_topic_cluster` detection

import path from "node:path";
import { ticketStage, type Ticket } from "../core/index.ts";
import { sanitizeArtifactName } from "./artifacts.ts";
import { clip } from "./text.ts";

/** Exact `FILES_ALONE` sentinel emitted by WeChat bridge (`wechat.ts`). */
const FILES_ALONE_TEXT = "[用户只发送了文件，没有说明要做什么；请先确认需求再处理]";

const DEFAULT_MIN_SCORE_SAME = 6.5;
const DEFAULT_MIN_SCORE_CROSS = 10.5;
const DEFAULT_SEARCH_MIN_SCORE = 3.0;
const MAX_SCAN_CHARS = 4096;
const ASKED_INDEX_MAX_CHARS = 1200;
const REPORT_INDEX_MAX_CHARS = 400;
const CLUSTER_WINDOW_MS = 48 * 3600 * 1000;

/** Field names indexed per ticket, ordered from highest to lowest weight. */
export type RecallField = "title" | "artifacts" | "digest" | "asked" | "worktree" | "reportHead";

const FIELD_ORDER: readonly RecallField[] = [
  "title",
  "artifacts",
  "digest",
  "asked",
  "worktree",
  "reportHead",
];

const FIELD_BIT: Record<RecallField, number> = {
  title: 1 << 0,
  artifacts: 1 << 1,
  digest: 1 << 2,
  asked: 1 << 3,
  worktree: 1 << 4,
  reportHead: 1 << 5,
};

const FIELD_WEIGHT: Record<RecallField, number> = {
  title: 3.0,
  artifacts: 2.8,
  digest: 2.2,
  asked: 1.8,
  worktree: 1.5,
  reportHead: 0.8,
};

const STRONG_FIELD_MASK =
  FIELD_BIT.title | FIELD_BIT.artifacts | FIELD_BIT.digest | FIELD_BIT.worktree;

/** Runtime recall feature flags read from environment variables (never persisted to `Settings`). */
export interface RecallConfig {
  /** Passive relevance recall into candidate cards (`NEO_RECALL_CANDIDATE_RELEVANCE !== "0"`). */
  candidateRelevance: boolean;
  /** Active `orchestrator_search` tool availability (`NEO_RECALL_SEARCH_TOOL !== "0"`). */
  searchTool: boolean;
  /** Pre-routing `clarify` flow availability (`NEO_RECALL_CLARIFY !== "0"`). */
  clarify: boolean;
  /** Controlled cross-surface recall (`NEO_RECALL_CROSS_SURFACE === "1"`, default `false`). */
  crossSurface: boolean;
  /** Minimum score for passive same-thread recall (`NEO_RECALL_MIN_SCORE`, default `6.5`). */
  minScoreSame: number;
  /** Minimum score for passive cross-thread recall (`max(10.5, minScoreSame * 1.55)`). */
  minScoreCross: number;
}

/** Read current recall rollout flags and thresholds from environment variables. */
export function recallConfig(): RecallConfig {
  const rawMin = process.env.NEO_RECALL_MIN_SCORE;
  let minScoreSame = DEFAULT_MIN_SCORE_SAME;
  if (rawMin !== undefined && rawMin.trim().length > 0) {
    const parsed = Number.parseFloat(rawMin.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      minScoreSame = parsed;
    }
  }
  const minScoreCross = Math.max(DEFAULT_MIN_SCORE_CROSS, minScoreSame * 1.55);
  return {
    candidateRelevance: process.env.NEO_RECALL_CANDIDATE_RELEVANCE !== "0",
    searchTool: process.env.NEO_RECALL_SEARCH_TOOL !== "0",
    clarify: process.env.NEO_RECALL_CLARIFY !== "0",
    crossSurface: process.env.NEO_RECALL_CROSS_SURFACE === "1",
    minScoreSame,
    minScoreCross,
  };
}

// ---------------------------------------------------------------------------
// Text sanitization & Neo template stripping
// ---------------------------------------------------------------------------

const ATTACHMENT_CLOSED_RE = /<attachment\b([^>]*)>[\s\S]*?<\/attachment>/gi;
const ATTACHMENT_UNCLOSED_RE = /<attachment\b([^>]*)>[\s\S]*$/gi;
const ATTACHMENT_NAME_ATTR_RE = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const QUOTED_FILE_RE = /\[引用的文件：([^\]]*)\]/g;
const VOICE_TAG_RE = /\[语音转写\]\s*/g;
const QUOTE_TAG_RE = /\[引用\]\s*/g;
const FETCH_FAILED_RE = /[（(]未能取回文件内容[）)]/g;
const ATTACHMENT_BOILERPLATE_RE =
  /File saved at the path above\.\s*Use read or bash to inspect or transform it as needed;\s*do not execute it implicitly\./gi;
const NEWLINE_TAB_RE = /[\r\n\t]+/g;
const ASCII_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;
const BIDI_ZERO_WIDTH_RE = /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\uFEFF\u061C]/g;
const WHITESPACE_RUN_RE = /\p{White_Space}+/gu;
const EDGE_WHITESPACE_RE = /^\p{White_Space}+|\p{White_Space}+$/gu;
const LEADING_INDEX_PREFIX_RE = /^\d+-/;
const TRAILING_EXT_RE = /\.[A-Za-z0-9]{1,8}$/;

function unescapeHtmlEntities(text: string): string {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function stripUnsafeChars(text: string): string {
  return text
    .replace(NEWLINE_TAB_RE, " ")
    .replace(ASCII_CONTROL_RE, "")
    .replace(BIDI_ZERO_WIDTH_RE, "")
    .replace(WHITESPACE_RUN_RE, " ")
    .replace(EDGE_WHITESPACE_RE, "");
}

function cleanAttachmentStem(rawName: string): string {
  const unescaped = unescapeHtmlEntities(rawName)
    .replace(FETCH_FAILED_RE, "")
    .trim();
  if (unescaped.length === 0) {
    return "";
  }
  const parts = unescaped.split(/[\\/]+/).filter((part) => part.length > 0);
  const base = parts.length > 0 ? parts[parts.length - 1] : unescaped;
  const noPrefix = base.replace(LEADING_INDEX_PREFIX_RE, "");
  const noExt = noPrefix.replace(TRAILING_EXT_RE, "");
  return stripUnsafeChars(noExt);
}

/**
 * Clean untrusted text before placing it on any candidate card or search result:
 * - Replaces `<attachment>...</attachment>` blocks with `[附件]`
 * - Strips `[语音转写]`, `[引用]`, `[引用的文件：...]`, `（未能取回文件内容）`, and `FILES_ALONE`
 * - Returns `""` if the entire input is `FILES_ALONE` or `"请查看附件。"`
 * - Strips ASCII control characters and Unicode BiDi/zero-width overrides
 * - Collapses whitespace and clips to `maxChars` code points
 */
export function sanitizeCardText(text: string, maxChars = 160): string {
  if (text.length === 0 || maxChars <= 0) {
    return "";
  }
  const trimmedInitial = stripUnsafeChars(text);
  if (
    trimmedInitial.length === 0 ||
    trimmedInitial === FILES_ALONE_TEXT ||
    trimmedInitial === "请查看附件。"
  ) {
    return "";
  }
  const replaced = text
    .replace(ATTACHMENT_CLOSED_RE, " [附件] ")
    .replace(ATTACHMENT_UNCLOSED_RE, " [附件] ")
    .replace(ATTACHMENT_BOILERPLATE_RE, " ")
    .replaceAll(FILES_ALONE_TEXT, " ")
    .replace(VOICE_TAG_RE, " ")
    .replace(QUOTE_TAG_RE, " ")
    .replace(QUOTED_FILE_RE, " ")
    .replace(FETCH_FAILED_RE, " ");

  const cleaned = stripUnsafeChars(replaced);
  if (cleaned.length === 0 || cleaned === FILES_ALONE_TEXT || cleaned === "请查看附件。") {
    return "";
  }
  return clip(cleaned, maxChars);
}

/** Output of stripping Neo message templates before indexing or querying. */
export interface StrippedIndexText {
  /** Cleaned user text with attachment bodies and system templates removed. */
  text: string;
  /** Basenames (without numeric `1-` prefix or file extension) extracted from `<attachment>` or quoted files. */
  attachmentNames: string[];
}

/**
 * Strip Neo system templates and attachment bodies prior to tokenization/indexing:
 * - Extracts cleaned basenames (no `1-` prefix, no extension) from `<attachment name="...">` and `[引用的文件：...]`
 * - Completely discards `<attachment>` tag bodies and `"File saved at the path above..."` boilerplate
 * - Strips `FILES_ALONE`, `"请查看附件。"`, `[语音转写]`, `[引用]`, and `（未能取回文件内容）`
 */
export function stripTemplatesForIndex(text: string): StrippedIndexText {
  if (text.length === 0) {
    return { text: "", attachmentNames: [] };
  }
  const names: string[] = [];
  const seenNames = new Set<string>();
  const addName = (raw: string): void => {
    const stem = cleanAttachmentStem(raw);
    if (stem.length > 0 && !seenNames.has(stem)) {
      seenNames.add(stem);
      names.push(stem);
    }
  };

  let working = text.replace(ATTACHMENT_CLOSED_RE, (_full, attrs: string) => {
    const match = ATTACHMENT_NAME_ATTR_RE.exec(attrs);
    const rawName = match?.[1] ?? match?.[2];
    if (rawName !== undefined) {
      addName(rawName);
    }
    return " ";
  });

  working = working.replace(ATTACHMENT_UNCLOSED_RE, (_full, attrs: string) => {
    const match = ATTACHMENT_NAME_ATTR_RE.exec(attrs);
    const rawName = match?.[1] ?? match?.[2];
    if (rawName !== undefined) {
      addName(rawName);
    }
    return " ";
  });

  working = working.replace(QUOTED_FILE_RE, (_full, inner: string) => {
    addName(inner);
    return " ";
  });

  working = working
    .replace(ATTACHMENT_BOILERPLATE_RE, " ")
    .replaceAll(FILES_ALONE_TEXT, " ")
    .replace(VOICE_TAG_RE, " ")
    .replace(QUOTE_TAG_RE, " ")
    .replace(FETCH_FAILED_RE, " ");

  const cleaned = stripUnsafeChars(working);
  if (cleaned === "请查看附件。" || cleaned === "请查看附件" || cleaned === "[附件]") {
    return { text: "", attachmentNames: names };
  }
  return { text: cleaned, attachmentNames: names };
}

// ---------------------------------------------------------------------------
// Atomic compound numeral extraction & boundary-safe hybrid tokenization
// ---------------------------------------------------------------------------

/** Classification of a token emitted by {@link tokenizeForRecall}. */
export type TokenKind =
  | "num"
  | "numunit"
  | "ver"
  | "zh_word"
  | "zh_2gram"
  | "en"
  | "mixed"
  | "generic"
  | "weak";

/** Atomic numeric or version fact tracked for mutual-exclusion conflict detection. */
export interface NumericFact {
  /** Conflict category, e.g. `"amount"`, `"unit:大洲"`, `"unit:年"`, `"unit:季度"`, `"version"`. */
  category: string;
  /** Numeric magnitude (`NaN` for version strings). */
  numericValue: number;
  /** Canonical comparison key. */
  canonical: string;
  /** Compact human-readable form for `conflict_signals`, e.g. `"20万"`, `"5大洲"`, `"v2.2"`. */
  display: string;
  /** Indexed token key corresponding to this fact. */
  token: string;
}

/** One normalized token produced by {@link tokenizeForRecall}. */
export interface RecallToken {
  /** Normalized token key stored in the inverted index. */
  term: string;
  /** Token category. */
  kind: TokenKind;
  /** Whether this token counts as a substantive entity (false for generic domain words and weak years/small ints). */
  isEntity: boolean;
  /** Base weight / gamma multiplier. */
  weight: number;
  /** Originating span group id so a parent word and its internal sub-tokens are never double-counted. */
  groupId: number;
  /** Strong entity flag (compound numeral, version, >=3-char natural zh word, or compound identifier). */
  isStrong: boolean;
  /** True when emitted only as a fallback unit noun of a compound numeral (e.g. `大洲` from `五大洲`). */
  isUnitFallback?: boolean;
  /** Conflict category when this token is tied to a {@link NumericFact}. */
  conflictCategory?: string;
}

/** Result of {@link tokenizeForRecall}. */
export interface TokenizedRecall {
  /** Deduplicated normalized tokens (capped at `maxTokens`). */
  tokens: RecallToken[];
  /** Extracted atomic numeric/version facts for conflict detection. */
  numerics: NumericFact[];
  /** Count of distinct substantive entity groups. */
  entityCount: number;
  /** Non-whitespace/non-punctuation character length of the normalized text. */
  effectiveLength: number;
  /** True if text explicitly asks to create a brand-new separate work item. */
  hasNewTaskIntent: boolean;
}

const ZH_SEGMENTER = new Intl.Segmenter("zh-CN", { granularity: "word" });

const ZH_DIGIT_MAP: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const ZH_SMALL_UNIT_MAP: Readonly<Record<string, number>> = {
  十: 10,
  百: 100,
  千: 1000,
};

const ZH_BIG_UNIT_MAP: Readonly<Record<string, number>> = {
  万: 10_000,
  亿: 100_000_000,
};

const NEW_TASK_INTENT_RE =
  /(?:新做一个|新做一份|新开一个|新开一份|另起一份|另起一个|重新做一个|重新做一份|新建一个|新建一份|重新写一份|另写一份|重做一个|重做一份|帮我新做|帮我另起|帮我新建)/;

const VERSION_RE =
  /(?<![A-Za-z0-9])v(\d+(?:\.\d+)*(?:[_-](?:[a-z]\d+|\d+[a-z]*|rc\d*|beta\d*|alpha\d*))?)(?![A-Za-z0-9])/gi;
const YEAR_RE = /(?<![A-Za-z0-9_])(202\d|2030)(?:年)?(?![A-Za-z0-9_])/g;
const QUARTER_EN_RE = /(?<![A-Za-z0-9_])q([1-4])(?![A-Za-z0-9_])/gi;
const QUARTER_ZH_RE = /(?:第)?([一二三四1-4])\s*季度/g;
const ARABIC_AMOUNT_RE =
  /(?<![A-Za-z0-9_.,])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(亿|千万|百万|十万|万|千|(?:[wW]|[kK])(?![A-Za-z_]))/g;
const ZH_AMOUNT_RE =
  /(?:[一二两三四五六七八九][零〇一二两三四五六七八九十百千]*|十[一二两三四五六七八九]?)(?:点[零〇一二三四五六七八九]+)?(?:[万亿千])(?:(?:[零〇]?[一二两三四五六七八九][千百十])+|[一二两三四五六七八九](?=(?:元|块|人民币|美元|欧元|港币|左右|以内|以上|以下|预算|[，。！？、,.\s]|$)))?/g;
const QIANWAN_CURRENCY_RE =
  /(?<![一二两三四五六七八九十百\d])千万(?=(?:元|人民币|美元|欧元|港币|预算|资金|投资|融资|营收|利润|级别|用户|资产))/g;
const CURRENCY_SMALL_RE =
  /(?<![A-Za-z0-9_])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?|[一二两三四五六七八九十百]+)\s*(元|块|人民币|rmb|cny|美元|usd|欧元|eur|日元|jpy|英镑|gbp|港币|hkd)(?![A-Za-z0-9_])/gi;
const HALF_DURATION_RE = /(?<![一二两三四五六七八九十\d])半(年|个月|小时)/g;
const TECH_UNIT_RE =
  /(?<![A-Za-z0-9_])(\d+(?:\.\d+)?)\s*(%|(?:gb|mb|tb|kb|ghz|mhz|ms|px|fps|hz|rpm|db|kw|mw|mah)(?![A-Za-z0-9_]))/gi;
const DOMAIN_UNIT_RE =
  /(?<![A-Za-z0-9_])(?:第)?(\d+(?:\.\d+)?|[一二两三四五六七八九十百]+)\s*(大洲|周年|个月|小时|分钟|公里|千米|平方米|平米|平方|国家|城市|省份|阶段|步骤|章节|板块|因子|维度|节点|线程|核心|套餐|景区|景点|洲|年|月|周|天|日|期|代|版|级|层|档|折|倍|强|人|组|队|核|卡|台|页|章|节|米|公斤|斤|克|吨|度|岁|号|路|线|区|楼)/g;
const STANDALONE_NUMBER_RE =
  /(?<![A-Za-z0-9_])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?![A-Za-z0-9_])/g;
const MIXED_LATIN_CJK_RE = /(?<![A-Za-z0-9])([A-Za-z])([股端线盘光恤])/g;
const CJK_RUN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/g;
const IDENTIFIER_RE = /[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*/g;
const EFFECTIVE_CHAR_RE = /[\p{L}\p{N}]/gu;

const TEMPORAL_UNITS: ReadonlySet<string> = new Set(["年", "月", "周", "天", "小时", "分钟"]);
const TEMPORAL_FOLLOW_GUARD_RE = /^[前后内来底初中末]/;
const TEMPORAL_PRECEDE_GUARD_RE = /[上下去今明每几这那近前后过]$/;

const UNIT_CANONICAL_MAP: Readonly<Record<string, string>> = {
  大洲: "大洲",
  洲: "大洲",
  周年: "年",
  年: "年",
  个月: "月",
  月: "月",
  周: "周",
  天: "天",
  日: "天",
  小时: "小时",
  分钟: "分钟",
  公里: "公里",
  千米: "公里",
  平方米: "平方",
  平米: "平方",
  平方: "平方",
  国家: "国家",
  城市: "城市",
  省份: "省份",
  阶段: "阶段",
  步骤: "步骤",
  章节: "章",
  章: "章",
  节: "节",
  板块: "板块",
  因子: "因子",
  维度: "维度",
  节点: "节点",
  线程: "线程",
  核心: "核心",
  套餐: "套餐",
  景区: "景区",
  景点: "景区",
  期: "期",
  代: "代",
  版: "版",
  级: "级",
  层: "层",
  档: "档",
  折: "折",
  倍: "倍",
  强: "强",
  人: "人",
  组: "组",
  队: "队",
  核: "核",
  卡: "卡",
  台: "台",
  页: "页",
  米: "米",
  公斤: "公斤",
  斤: "斤",
  克: "克",
  吨: "吨",
  度: "度",
  岁: "岁",
  号: "号",
  路: "路",
  线: "线",
  区: "区",
  楼: "楼",
};

/** High-frequency Chinese function/instruction stopwords acting as hard segmentation boundaries. */
const ZH_STOPWORDS: ReadonlySet<string> = new Set([
  // Required multi-char stopwords from design spec
  "帮我",
  "给我",
  "一下",
  "一个",
  "这个",
  "那个",
  "包含",
  "哪些",
  "什么",
  "怎么",
  "为什么",
  "有没有",
  "之前",
  "刚才",
  "上次",
  "一份",
  "现在",
  "可以",
  "能否",
  "想要",
  "需要",
  "就是",
  "还是",
  "以及",
  "或者",
  "还有",
  "关于",
  "里面",
  // Additional chat discourse & instruction stopwords
  "请问",
  "麻烦",
  "帮忙",
  "谢谢",
  "感谢",
  "多谢",
  "你好",
  "您好",
  "好的",
  "好吧",
  "收到",
  "明白",
  "知道",
  "知道了",
  "了解",
  "可以吗",
  "行不行",
  "好不好",
  "怎么样",
  "怎么了",
  "是不是",
  "能不能",
  "可不可以",
  "干嘛",
  "什么样",
  "多少",
  "几个",
  "几份",
  "哪份",
  "哪张",
  "哪条",
  "哪个",
  "那份",
  "这份",
  "那些",
  "这些",
  "这里",
  "那里",
  "其中",
  "当中",
  "已经",
  "曾经",
  "原来",
  "当时",
  "刚才",
  "刚刚",
  "马上",
  "立刻",
  "赶紧",
  "稍微",
  "一下吗",
  "哈哈",
  "哈哈哈",
  "呵呵",
  "嗯嗯",
  "哦哦",
  "好的呢",
  "谢谢你",
  "太好了",
  "没问题",
  "不用了",
  "算了",
  "新做",
  "另起",
  "重新",
  "新建",
  "重做",
  "再做",
  "新开",
  "看看",
  "看一下",
  "查一下",
  "找一下",
  "问一下",
  "改一下",
  "写一下",
  "做一下",
  "说一下",
  "发一下",
  "列一下",
  "告诉",
  "回答",
  "回复",
  "处理",
  "准备",
  "开始",
  "继续",
  "停止",
  "取消",
  // Safe pure-function single-character stopwords (matched only when `Intl.Segmenter` emits them alone)
  "的",
  "了",
  "吗",
  "呢",
  "啊",
  "吧",
  "呀",
  "嘛",
  "呗",
  "啦",
  "咯",
  "哦",
  "嗯",
  "噢",
  "哎",
  "诶",
  "哇",
  "呐",
  "哈",
  "我",
  "你",
  "他",
  "她",
  "它",
  "咱",
  "帮",
  "请",
  "给",
  "把",
  "被",
  "让",
  "在",
  "从",
  "到",
  "向",
  "往",
  "和",
  "与",
  "跟",
  "及",
  "或",
  "而",
  "且",
  "但",
  "却",
  "就",
  "都",
  "也",
  "还",
  "又",
  "再",
  "很",
  "太",
  "真",
  "更",
  "最",
  "只",
  "才",
  "已",
  "没",
  "别",
  "份",
  "个",
  "条",
  "张",
  "篇",
  "段",
  "句",
  "里",
  "写",
  "做",
  "看",
  "找",
  "问",
  "说",
  "弄",
  "搞",
  "啥",
  "哪",
  "几",
  "着",
  "过",
  "得",
  "地",
  "之",
  "其",
  "所",
  "于",
]);

/** High-frequency English stopwords dropped during identifier tokenization. */
const EN_STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "these",
  "those",
  "what",
  "how",
  "why",
  "who",
  "which",
  "when",
  "where",
  "can",
  "could",
  "would",
  "should",
  "please",
  "help",
  "make",
  "create",
  "about",
  "into",
  "onto",
  "your",
  "our",
  "its",
  "their",
  "are",
  "was",
  "were",
  "been",
  "have",
  "has",
  "had",
  "does",
  "did",
  "not",
  "but",
  "all",
  "any",
  "some",
  "just",
  "only",
  "also",
  "very",
  "too",
  "more",
  "most",
  "than",
  "then",
  "will",
  "may",
  "might",
  "here",
  "there",
  "yes",
  "no",
  "ok",
  "okay",
  "thanks",
  "thank",
  "hi",
  "hello",
  "hey",
  "you",
  "me",
  "my",
  "we",
  "it",
  "is",
  "be",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "an",
  "as",
  "or",
  "if",
  "so",
  "do",
  "up",
  "out",
  "new",
]);

/**
 * Static generic domain words forced to `gamma = 0.25` and `isEntity = false`.
 * Prevents generic phrasing ("修改按钮", "帮我写份报告", "整理一下清单") from triggering passive recall.
 */
const GENERIC_DOMAIN_WORDS: ReadonlySet<string> = new Set([
  // Required Chinese generic domain words
  "计划",
  "方案",
  "报告",
  "优化",
  "修改",
  "更新",
  "按钮",
  "模型",
  "策略",
  "列表",
  "分析",
  "修复",
  "部署",
  "排查",
  "总结",
  "整理",
  "文档",
  "版本",
  "数据",
  "参数",
  "文件",
  "配置",
  "接口",
  "代码",
  "页面",
  "脚本",
  "结果",
  "功能",
  "问题",
  "攻略",
  "项目",
  "任务",
  "清单",
  "内容",
  "信息",
  "情况",
  "进度",
  // Closely related generic wrappers/nouns
  "报错",
  "异常",
  "日志",
  "样式",
  "模板",
  "附件",
  "材料",
  "资料",
  "草稿",
  "说明",
  "指南",
  "手册",
  // Required English generic domain words
  "pdf",
  "md",
  "csv",
  "json",
  "txt",
  "png",
  "plan",
  "report",
  "fix",
  "update",
  "add",
  "test",
  "run",
  "check",
  "opt",
  "bug",
  "error",
  "log",
  "file",
  // Closely related English file extensions & generic terms
  "docx",
  "xlsx",
  "pptx",
  "html",
  "htm",
  "jpg",
  "jpeg",
  "webp",
  "svg",
  "zip",
  "yaml",
  "yml",
  "doc",
  "docs",
  "button",
  "config",
  "script",
  "code",
  "page",
  "task",
  "project",
  "summary",
  "status",
  "list",
  "data",
  "param",
  "params",
  "issue",
  "version",
  "result",
]);

function formatNumKey(val: number): string {
  if (Number.isInteger(val)) {
    return String(val);
  }
  return String(Number(val.toFixed(4)));
}

function formatAmountDisplay(val: number): string {
  if (val >= 100_000_000 && val % 10_000_000 === 0) {
    return `${formatNumKey(val / 100_000_000)}亿`;
  }
  if (val >= 10_000 && val % 1_000 === 0) {
    return `${formatNumKey(val / 10_000)}万`;
  }
  return formatNumKey(val);
}

/** Parse Chinese numeral strings (e.g. `十万`, `二十万`, `两万五`, `一点五万`, `三十万五千`) into a number. */
function parseChineseNumber(raw: string): number {
  if (raw === "半") {
    return 0.5;
  }
  const dotIdx = raw.indexOf("点");
  if (dotIdx !== -1) {
    const intPart = raw.slice(0, dotIdx);
    let rest = raw.slice(dotIdx + 1);
    let unitMult = 1;
    if (rest.endsWith("亿")) {
      unitMult = 100_000_000;
      rest = rest.slice(0, -1);
    } else if (rest.endsWith("万")) {
      unitMult = 10_000;
      rest = rest.slice(0, -1);
    } else if (rest.endsWith("千")) {
      unitMult = 1_000;
      rest = rest.slice(0, -1);
    } else if (rest.endsWith("百")) {
      unitMult = 100;
      rest = rest.slice(0, -1);
    }
    const baseInt = intPart.length > 0 ? parseChineseNumber(intPart) : 0;
    if (!Number.isFinite(baseInt)) {
      return Number.NaN;
    }
    let fracStr = "";
    for (let i = 0; i < rest.length; i++) {
      const d = ZH_DIGIT_MAP[rest[i]];
      if (d === undefined) {
        return Number.NaN;
      }
      fracStr += String(d);
    }
    const frac = fracStr.length > 0 ? Number.parseFloat(`0.${fracStr}`) : 0;
    return (baseInt + frac) * unitMult;
  }

  let total = 0;
  let section = 0;
  let num = -1;
  let lastUnit = 0;
  let seenZero = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const digit = ZH_DIGIT_MAP[ch];
    if (digit !== undefined) {
      if (digit === 0) {
        seenZero = true;
        num = 0;
      } else {
        if (num > 0) {
          // Reject malformed adjacent bare digits like "一二" without an intervening unit.
          return Number.NaN;
        }
        num = digit;
      }
      continue;
    }
    const small = ZH_SMALL_UNIT_MAP[ch];
    if (small !== undefined) {
      const factor = num <= 0 ? 1 : num;
      section += factor * small;
      num = -1;
      lastUnit = small;
      seenZero = false;
      continue;
    }
    const big = ZH_BIG_UNIT_MAP[ch];
    if (big !== undefined) {
      const secVal = section + (num > 0 ? num : 0);
      if (secVal === 0 && total > 0 && big === 100_000_000) {
        total *= big;
      } else {
        total += (secVal === 0 ? 1 : secVal) * big;
      }
      section = 0;
      num = -1;
      lastUnit = big;
      seenZero = false;
      continue;
    }
    return Number.NaN;
  }

  if (num > 0) {
    if (!seenZero && lastUnit >= 100) {
      section += num * (lastUnit / 10);
    } else {
      section += num;
    }
  }
  return total + section;
}

function parseArabicOrZhNumber(raw: string): number {
  const cleaned = raw.replaceAll(",", "");
  if (/^\d+(?:\.\d+)?$/.test(cleaned)) {
    return Number.parseFloat(cleaned);
  }
  return parseChineseNumber(cleaned);
}

function splitCamelCase(ident: string): string[] {
  const spaced = ident
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return spaced.split(/[\s_-]+/).filter((part) => part.length > 0);
}

/**
 * Boundary-safe, atomic-numeral-aware tokenizer for historical ticket recall.
 *
 * Pipeline:
 * 1. NFKC normalization + bounded scan length (`4096` chars)
 * 2. Atomic extraction of versions, years, quarters, compound amounts (`二十万`/`20万`),
 *    domain-unit numerals (`五大洲`/`5大洲`/`半年`/`100%`), standalone numbers, and mixed Latin+CJK (`A股`)
 *    — extracted spans are replaced by spaces so they NEVER enter 2-gram sliding windows!
 * 3. Boundary-safe Chinese segmentation via `Intl.Segmenter("zh-CN")` + OOV single-char merge +
 *    internal 2-grams without bridging across stopwords or generic domain words
 * 4. English/identifier camelCase/kebab-case/snake_case splitting (retaining full identifier)
 * 5. Static generic domain word dampening (`gamma = 0.25`, `isEntity = false`) and `maxTokens` cap
 */
export function tokenizeForRecall(rawText: string, maxTokens = 64): TokenizedRecall {
  if (rawText.length === 0 || maxTokens <= 0) {
    return {
      tokens: [],
      numerics: [],
      entityCount: 0,
      effectiveLength: 0,
      hasNewTaskIntent: false,
    };
  }

  const normalized = clip(rawText.normalize("NFKC"), MAX_SCAN_CHARS);
  const effectiveMatches = normalized.match(EFFECTIVE_CHAR_RE);
  const effectiveLength = effectiveMatches !== null ? effectiveMatches.length : 0;
  const hasNewTaskIntent = NEW_TASK_INTENT_RE.test(normalized);

  const tokenMap = new Map<string, RecallToken>();
  const numerics: NumericFact[] = [];
  const seenNumericKeys = new Set<string>();
  let nextGroupId = 1;

  const addToken = (token: RecallToken): void => {
    const existing = tokenMap.get(token.term);
    if (existing !== undefined) {
      if (token.weight > existing.weight) {
        existing.weight = token.weight;
      }
      if (token.isEntity && !existing.isEntity) {
        existing.isEntity = true;
      }
      if (token.isStrong && !existing.isStrong) {
        existing.isStrong = true;
      }
      if (existing.isUnitFallback && !token.isUnitFallback) {
        existing.isUnitFallback = false;
      }
      return;
    }
    if (tokenMap.size >= maxTokens) {
      return;
    }
    tokenMap.set(token.term, token);
  };

  const addNumericFact = (fact: NumericFact): void => {
    const key = `${fact.category}:${fact.canonical}`;
    if (seenNumericKeys.has(key)) {
      return;
    }
    seenNumericKeys.add(key);
    numerics.push(fact);
  };

  let working = normalized;

  // Pass A: Version tokens (e.g. v2.2, v4_f1, V3)
  working = working.replace(VERSION_RE, (match) => {
    const lower = match.toLowerCase();
    const token = `ver:${lower}`;
    const gid = nextGroupId++;
    addNumericFact({
      category: "version",
      numericValue: Number.NaN,
      canonical: lower,
      display: lower,
      token,
    });
    addToken({
      term: token,
      kind: "ver",
      isEntity: true,
      weight: 1.4,
      groupId: gid,
      isStrong: true,
      conflictCategory: "version",
    });
    return " ";
  });

  // Pass B: Years 2020-2030 (weak: isEntity = false, gamma = 0.20)
  working = working.replace(YEAR_RE, (_match, yearStr: string) => {
    const gid = nextGroupId++;
    addToken({
      term: `year:${yearStr}`,
      kind: "weak",
      isEntity: false,
      weight: 0.2,
      groupId: gid,
      isStrong: false,
    });
    return " ";
  });

  // Pass C: Quarters (Q1-Q4, 第一季度-第四季度, 一季度-四季度)
  working = working.replace(QUARTER_EN_RE, (_match, qStr: string) => {
    const val = Number.parseInt(qStr, 10);
    const token = `numunit:${val}_季度`;
    const gid = nextGroupId++;
    addNumericFact({
      category: "unit:季度",
      numericValue: val,
      canonical: String(val),
      display: `Q${val}`,
      token,
    });
    addToken({
      term: token,
      kind: "numunit",
      isEntity: true,
      weight: 1.4,
      groupId: gid,
      isStrong: true,
      conflictCategory: "unit:季度",
    });
    return " ";
  });

  working = working.replace(QUARTER_ZH_RE, (_match, qStr: string) => {
    const val = parseArabicOrZhNumber(qStr);
    if (!Number.isFinite(val) || val < 1 || val > 4) {
      return _match;
    }
    const token = `numunit:${val}_季度`;
    const gid = nextGroupId++;
    addNumericFact({
      category: "unit:季度",
      numericValue: val,
      canonical: String(val),
      display: `Q${val}`,
      token,
    });
    addToken({
      term: token,
      kind: "numunit",
      isEntity: true,
      weight: 1.4,
      groupId: gid,
      isStrong: true,
      conflictCategory: "unit:季度",
    });
    return " ";
  });

  // Pass D1: Arabic numbers with magnitude multipliers (20万, 10w, 10k, 1.5万, 2亿)
  working = working.replace(ARABIC_AMOUNT_RE, (full, numRaw: string, multRaw: string) => {
    const base = Number.parseFloat(numRaw.replaceAll(",", ""));
    if (!Number.isFinite(base) || base <= 0) {
      return full;
    }
    const m = multRaw.toLowerCase();
    let factor = 1;
    if (m === "亿") factor = 100_000_000;
    else if (m === "千万") factor = 10_000_000;
    else if (m === "百万") factor = 1_000_000;
    else if (m === "十万") factor = 100_000;
    else if (m === "万" || m === "w") factor = 10_000;
    else if (m === "千" || m === "k") factor = 1_000;

    const val = Math.round(base * factor * 10000) / 10000;
    const canon = formatNumKey(val);
    const token = `num:${canon}`;
    const gid = nextGroupId++;
    addNumericFact({
      category: "amount",
      numericValue: val,
      canonical: canon,
      display: formatAmountDisplay(val),
      token,
    });
    addToken({
      term: token,
      kind: "num",
      isEntity: true,
      weight: 1.4,
      groupId: gid,
      isStrong: true,
      conflictCategory: "amount",
    });
    return " ";
  });

  // Pass D2: Chinese compound amount numerals (二十万, 十万, 两万五, 一百万, 三千, 两亿)
  working = working.replace(ZH_AMOUNT_RE, (full) => {
    const val = parseChineseNumber(full);
    if (!Number.isFinite(val) || val < 1000) {
      return full;
    }
    const canon = formatNumKey(val);
    const token = `num:${canon}`;
    const gid = nextGroupId++;
    addNumericFact({
      category: "amount",
      numericValue: val,
      canonical: canon,
      display: formatAmountDisplay(val),
      token,
    });
    addToken({
      term: token,
      kind: "num",
      isEntity: true,
      weight: 1.4,
      groupId: gid,
      isStrong: true,
      conflictCategory: "amount",
    });
    return " ";
  });

  // Pass D3: Bare "千万" only when clearly followed by currency/financial nouns
  working = working.replace(QIANWAN_CURRENCY_RE, () => {
    const val = 10_000_000;
    const token = "num:10000000";
    const gid = nextGroupId++;
    addNumericFact({
      category: "amount",
      numericValue: val,
      canonical: "10000000",
      display: "1000万",
      token,
    });
    addToken({
      term: token,
      kind: "num",
      isEntity: true,
      weight: 1.4,
      groupId: gid,
      isStrong: true,
      conflictCategory: "amount",
    });
    return " ";
  });

  // Pass D4: Smaller explicit currency amounts (e.g. 500元, 100美元)
  working = working.replace(CURRENCY_SMALL_RE, (full, numRaw: string, currRaw: string) => {
    const val = parseArabicOrZhNumber(numRaw);
    if (!Number.isFinite(val) || val <= 0) {
      return full;
    }
    const curr = currRaw.toLowerCase();
    const isCny = curr === "元" || curr === "块" || curr === "人民币" || curr === "rmb" || curr === "cny";
    const gid = nextGroupId++;
    const canon = formatNumKey(val);
    if (isCny) {
      const token = `num:${canon}`;
      addNumericFact({
        category: "amount",
        numericValue: val,
        canonical: canon,
        display: val >= 10_000 ? formatAmountDisplay(val) : `${canon}元`,
        token,
      });
      addToken({
        term: token,
        kind: "num",
        isEntity: true,
        weight: 1.4,
        groupId: gid,
        isStrong: true,
        conflictCategory: "amount",
      });
    } else {
      const unitMap: Record<string, string> = {
        美元: "usd",
        usd: "usd",
        欧元: "eur",
        eur: "eur",
        日元: "jpy",
        jpy: "jpy",
        英镑: "gbp",
        gbp: "gbp",
        港币: "hkd",
        hkd: "hkd",
      };
      const normCurr = unitMap[curr] ?? curr;
      const token = `numunit:${canon}_${normCurr}`;
      const category = `unit:${normCurr}`;
      addNumericFact({
        category,
        numericValue: val,
        canonical: canon,
        display: `${canon}${normCurr.toUpperCase()}`,
        token,
      });
      addToken({
        term: token,
        kind: "numunit",
        isEntity: true,
        weight: 1.4,
        groupId: gid,
        isStrong: true,
        conflictCategory: category,
      });
    }
    return " ";
  });

  // Pass E1: Half-durations (半年, 半个月, 半小时), guarding against relative-ago phrases (半年前)
  working = working.replace(HALF_DURATION_RE, (full, unitRaw: string, offset: number, src: string) => {
    const after = src.slice(offset + full.length);
    if (TEMPORAL_FOLLOW_GUARD_RE.test(after)) {
      return " ";
    }
    const canonUnit = UNIT_CANONICAL_MAP[unitRaw] ?? unitRaw;
    const category = `unit:${canonUnit}`;
    const token = `numunit:0.5_${canonUnit}`;
    const gid = nextGroupId++;
    addNumericFact({
      category,
      numericValue: 0.5,
      canonical: "0.5",
      display: `半${unitRaw}`,
      token,
    });
    addToken({
      term: token,
      kind: "numunit",
      isEntity: true,
      weight: 1.4,
      groupId: gid,
      isStrong: true,
      conflictCategory: category,
    });
    return " ";
  });

  // Pass E2: Arabic + technical units (100%, 16GB, 200ms)
  working = working.replace(TECH_UNIT_RE, (full, numRaw: string, unitRaw: string) => {
    const val = Number.parseFloat(numRaw);
    if (!Number.isFinite(val)) {
      return full;
    }
    const normUnit = unitRaw.toLowerCase();
    const canon = formatNumKey(val);
    const category = `unit:${normUnit}`;
    const token = `numunit:${canon}_${normUnit}`;
    const gid = nextGroupId++;
    addNumericFact({
      category,
      numericValue: val,
      canonical: canon,
      display: `${canon}${normUnit}`,
      token,
    });
    addToken({
      term: token,
      kind: "numunit",
      isEntity: true,
      weight: 1.4,
      groupId: gid,
      isStrong: true,
      conflictCategory: category,
    });
    return " ";
  });

  // Pass E3: Chinese/Arabic + domain units (五大洲/5大洲, 四大洲/4大洲, 一年/1年, 七日/7天)
  working = working.replace(
    DOMAIN_UNIT_RE,
    (full, numRaw: string, unitRaw: string, offset: number, src: string) => {
      const val = parseArabicOrZhNumber(numRaw);
      if (!Number.isFinite(val) || val <= 0) {
        return full;
      }
      const canonUnit = UNIT_CANONICAL_MAP[unitRaw] ?? unitRaw;
      if (TEMPORAL_UNITS.has(canonUnit)) {
        const before = src.slice(Math.max(0, offset - 1), offset);
        const after = src.slice(offset + full.length);
        if (TEMPORAL_FOLLOW_GUARD_RE.test(after) || TEMPORAL_PRECEDE_GUARD_RE.test(before)) {
          return " ";
        }
      }
      const canon = formatNumKey(val);
      const category = `unit:${canonUnit}`;
      const token = `numunit:${canon}_${canonUnit}`;
      const gid = nextGroupId++;
      addNumericFact({
        category,
        numericValue: val,
        canonical: canon,
        display: `${canon}${canonUnit}`,
        token,
      });
      addToken({
        term: token,
        kind: "numunit",
        isEntity: true,
        weight: 1.4,
        groupId: gid,
        isStrong: true,
        conflictCategory: category,
      });
      // Also emit multi-char domain unit itself (e.g. "大洲" from "五大洲") in the same group
      // so queries referencing just "大洲" can match while never double-counting with "五大洲".
      if (canonUnit.length >= 2 && !GENERIC_DOMAIN_WORDS.has(canonUnit) && !ZH_STOPWORDS.has(canonUnit)) {
        addToken({
          term: canonUnit,
          kind: "zh_word",
          isEntity: true,
          weight: 0.9,
          groupId: gid,
          isStrong: false,
          isUnitFallback: true,
          conflictCategory: category,
        });
      }
      return " ";
    },
  );

  // Pass F: Remaining standalone Arabic numbers
  working = working.replace(STANDALONE_NUMBER_RE, (full, numRaw: string) => {
    const val = Number.parseFloat(numRaw.replaceAll(",", ""));
    if (!Number.isFinite(val)) {
      return full;
    }
    const canon = formatNumKey(val);
    const token = `num:${canon}`;
    const gid = nextGroupId++;
    if (val >= 1000) {
      addNumericFact({
        category: "amount",
        numericValue: val,
        canonical: canon,
        display: formatAmountDisplay(val),
        token,
      });
      addToken({
        term: token,
        kind: "num",
        isEntity: true,
        weight: 1.4,
        groupId: gid,
        isStrong: true,
        conflictCategory: "amount",
      });
    } else if (val >= 100) {
      addToken({
        term: token,
        kind: "num",
        isEntity: true,
        weight: 1.0,
        groupId: gid,
        isStrong: false,
      });
    } else {
      // Unitless small integers 0..99 are weak (`isEntity = false`, `gamma = 0.20`).
      addToken({
        term: token,
        kind: "weak",
        isEntity: false,
        weight: 0.2,
        groupId: gid,
        isStrong: false,
      });
    }
    return " ";
  });

  // Pass G: Mixed single-letter + CJK domain terms (e.g. A股, H股, B端, C端, K线, U盘, X光, T恤)
  working = working.replace(MIXED_LATIN_CJK_RE, (_full, letter: string, cjk: string) => {
    const term = `${letter.toLowerCase()}${cjk}`;
    const gid = nextGroupId++;
    addToken({
      term,
      kind: "mixed",
      isEntity: true,
      weight: 1.2,
      groupId: gid,
      isStrong: false,
    });
    return " ";
  });

  // Pass H: Boundary-safe Chinese segmentation (Intl.Segmenter + OOV merge + internal 2-grams)
  let cjkMatch: RegExpExecArray | null;
  CJK_RUN_RE.lastIndex = 0;
  while ((cjkMatch = CJK_RUN_RE.exec(working)) !== null) {
    const run = cjkMatch[0];
    if (run.length < 2) {
      continue;
    }

    // Split run into clause groups bounded by Chinese stopwords.
    const groups: Array<Array<{ text: string; natural: boolean }>> = [];
    let currentGroup: Array<{ text: string; natural: boolean }> = [];

    for (const seg of ZH_SEGMENTER.segment(run)) {
      if (!seg.isWordLike) {
        if (currentGroup.length > 0) {
          groups.push(currentGroup);
          currentGroup = [];
        }
        continue;
      }
      const word = seg.segment;
      if (ZH_STOPWORDS.has(word)) {
        if (currentGroup.length > 0) {
          groups.push(currentGroup);
          currentGroup = [];
        }
        continue;
      }
      currentGroup.push({ text: word, natural: word.length >= 2 });
    }
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    for (let g = 0; g < groups.length; g++) {
      const rawSegs = groups[g];

      // 1) Merge consecutive single-character non-stopword OOV fragments (e.g. ["微","信"] -> "微信", ["可","视","化"] -> "可视化")
      const mergedRuns: Array<{ text: string; natural: boolean }> = [];
      for (let i = 0; i < rawSegs.length; i++) {
        const cur = rawSegs[i];
        if (cur.text.length === 1) {
          let combined = cur.text;
          while (i + 1 < rawSegs.length && rawSegs[i + 1].text.length === 1) {
            i += 1;
            combined += rawSegs[i].text;
          }
          mergedRuns.push({ text: combined, natural: false });
        } else {
          mergedRuns.push(cur);
        }
      }

      // 2) Attach stranded single-character modifiers to an adjacent segment (e.g. "慢"+"查询" -> "慢查询", "数据"+"库" -> "数据库")
      const units: Array<{ text: string; natural: boolean }> = [];
      for (let i = 0; i < mergedRuns.length; i++) {
        const cur = mergedRuns[i];
        if (cur.text.length === 1) {
          if (i + 1 < mergedRuns.length) {
            mergedRuns[i + 1] = {
              text: cur.text + mergedRuns[i + 1].text,
              natural: false,
            };
            continue;
          }
          if (units.length > 0) {
            units[units.length - 1] = {
              text: units[units.length - 1].text + cur.text,
              natural: false,
            };
            continue;
          }
          // Isolated single Chinese character is always dropped.
          continue;
        }
        units.push(cur);
      }

      // 3) Emit tokens per unit without bridging 2-grams across stopwords or generic domain words.
      for (let i = 0; i < units.length; i++) {
        const unit = units[i];
        const word = unit.text;
        if (word.length < 2 || ZH_STOPWORDS.has(word)) {
          continue;
        }
        const gid = nextGroupId++;
        if (GENERIC_DOMAIN_WORDS.has(word)) {
          addToken({
            term: word,
            kind: "generic",
            isEntity: false,
            weight: 0.25,
            groupId: gid,
            isStrong: false,
          });
          continue;
        }

        if (word.length === 2) {
          addToken({
            term: word,
            kind: unit.natural ? "zh_word" : "zh_2gram",
            isEntity: true,
            weight: unit.natural ? 1.15 : 1.0,
            groupId: gid,
            isStrong: false,
          });
        } else if (word.length <= 4) {
          // 3~4 char Chinese natural/compound word gets 1.3x weight + internal 2-grams in the same groupId.
          addToken({
            term: word,
            kind: "zh_word",
            isEntity: true,
            weight: 1.3,
            groupId: gid,
            isStrong: true,
          });
          for (let j = 0; j + 2 <= word.length; j++) {
            const bg = word.slice(j, j + 2);
            if (ZH_STOPWORDS.has(bg)) {
              continue;
            }
            if (GENERIC_DOMAIN_WORDS.has(bg)) {
              addToken({
                term: bg,
                kind: "generic",
                isEntity: false,
                weight: 0.25,
                groupId: gid,
                isStrong: false,
              });
            } else {
              addToken({
                term: bg,
                kind: "zh_2gram",
                isEntity: true,
                weight: 1.0,
                groupId: gid,
                isStrong: false,
              });
            }
          }
        } else {
          // Longer merged OOV run (>=5 chars): emit sliding 2-grams with separate groupIds for non-overlapping pairs
          // plus the full natural word if Intl.Segmenter emitted it whole (e.g. "个人所得税").
          if (unit.natural) {
            addToken({
              term: word,
              kind: "zh_word",
              isEntity: true,
              weight: 1.2,
              groupId: gid,
              isStrong: true,
            });
          }
          for (let j = 0; j + 2 <= word.length; j++) {
            const bg = word.slice(j, j + 2);
            if (ZH_STOPWORDS.has(bg)) {
              continue;
            }
            const subGid = unit.natural ? gid : nextGroupId++;
            if (GENERIC_DOMAIN_WORDS.has(bg)) {
              addToken({
                term: bg,
                kind: "generic",
                isEntity: false,
                weight: 0.25,
                groupId: subGid,
                isStrong: false,
              });
            } else {
              addToken({
                term: bg,
                kind: "zh_2gram",
                isEntity: true,
                weight: 1.0,
                groupId: subGid,
                isStrong: false,
              });
            }
          }
        }
      }
    }
  }

  // Pass I: English & identifier tokens (preserve full identifier + camelCase/snake_case/kebab-case parts)
  let idMatch: RegExpExecArray | null;
  IDENTIFIER_RE.lastIndex = 0;
  while ((idMatch = IDENTIFIER_RE.exec(working)) !== null) {
    const rawIdent = idMatch[0];
    const fullLower = rawIdent.toLowerCase();
    if (fullLower.length < 2 || EN_STOPWORDS.has(fullLower)) {
      continue;
    }

    const parts = splitCamelCase(rawIdent).map((part) => part.toLowerCase());
    const isCompound = parts.length > 1;
    const gid = nextGroupId++;

    if (GENERIC_DOMAIN_WORDS.has(fullLower)) {
      addToken({
        term: fullLower,
        kind: "generic",
        isEntity: false,
        weight: 0.25,
        groupId: gid,
        isStrong: false,
      });
    } else {
      addToken({
        term: fullLower,
        kind: "en",
        isEntity: true,
        weight: isCompound ? 1.25 : 1.1,
        groupId: gid,
        isStrong: isCompound,
      });
    }

    if (isCompound) {
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part.length < 2 || part === fullLower || EN_STOPWORDS.has(part)) {
          continue;
        }
        if (GENERIC_DOMAIN_WORDS.has(part)) {
          addToken({
            term: part,
            kind: "generic",
            isEntity: false,
            weight: 0.25,
            groupId: gid,
            isStrong: false,
          });
        } else {
          addToken({
            term: part,
            kind: "en",
            isEntity: true,
            weight: 1.0,
            groupId: gid,
            isStrong: false,
          });
        }
      }
    }
  }

  const tokens = Array.from(tokenMap.values());
  const entityGroups = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].isEntity && !tokens[i].isUnitFallback) {
      entityGroups.add(tokens[i].groupId);
    }
  }

  return {
    tokens,
    numerics,
    entityCount: entityGroups.size,
    effectiveLength,
    hasNewTaskIntent,
  };
}

// ---------------------------------------------------------------------------
// In-memory multi-field inverted index & dual-channel retrieval engine
// ---------------------------------------------------------------------------

/** Ticket shape optionally carrying collected deliverable artifact names. */
export type TicketWithArtifacts = Ticket & { artifacts?: readonly string[] };

/** Input record used to populate or incrementally update {@link TicketSearchIndex}. */
export interface TicketIndexInput {
  /** The ticket aggregate. */
  ticket: TicketWithArtifacts;
  /** Primary request text (e.g. origin trigger text or merged human batch text). */
  asked?: string;
  /** Thread keys associated with the ticket (subscribed threads + origin thread). */
  threads: readonly string[];
  /** Explicit deliverable artifact names; falls back to `ticket.artifacts` when omitted. */
  artifacts?: readonly string[];
}

/** Confidence tier for candidate recall and search results. */
export type RecallConfidence = "high" | "medium" | "ambiguous" | "none";

/** Compact sanitized card injected into the passive candidate slot (STRICTLY NO `matched_snippet`). */
export interface RecalledTicketCard {
  ticket_id: string;
  title: string;
  asked?: string;
  digest?: string;
  artifacts?: string[];
  state: string;
  updated: string;
  confidence: Exclude<RecallConfidence, "none">;
  matched_fields: RecallField[];
  conflict_signals?: string[];
  source_thread?: string;
}

/** Options for passive candidate-card recall (`recallForCandidate`). */
export interface CandidateRecallOptions {
  /** Human trigger texts in the current candidate batch (merged automatically). */
  queryTexts: readonly string[];
  /** Primary thread key of the current candidate. */
  currentThread: string;
  /** Thread keys the current actor is authorized to access. */
  allowedThreads: ReadonlySet<string>;
  /** Ticket ids already rendered in other slots or otherwise excluded. */
  excludeTicketIds?: ReadonlySet<string>;
  /** Ticket ids that handed back trigger(s) in this batch (hard excluded). */
  handedBackIds?: ReadonlySet<string>;
  /** Whether cross-thread recall within `allowedThreads` is permitted (defaults to `recallConfig().crossSurface`). */
  allowCrossThread?: boolean;
  /** Optional authorization revalidation callback (e.g. `policy.revalidate`). */
  revalidate?: (ticketId: string) => boolean;
  /** Reference wall clock in ms (defaults to `Date.now()`). */
  nowMs?: number;
  /** Maximum same-thread recalled cards (default `3`). */
  maxSameThread?: number;
  /** Maximum cross-thread recalled cards (default `2`). */
  maxCrossThread?: number;
  /** Optional threshold override for same-thread recall. */
  minScoreSame?: number;
  /** Optional threshold override for cross-thread recall. */
  minScoreCross?: number;
}

/** Result of passive candidate-card recall (`recallForCandidate`). */
export interface CandidateRecallResult {
  sameThread: RecalledTicketCard[];
  crossThread: RecalledTicketCard[];
  confidence: RecallConfidence;
}

/** One explainable hit returned by active `orchestrator_search` (`search`). */
export interface SearchTicketHit {
  ticket_id: string;
  title: string;
  asked?: string;
  digest?: string;
  artifacts?: string[];
  state: string;
  updated: string;
  score: number;
  confidence: Exclude<RecallConfidence, "none">;
  matched_fields: RecallField[];
  conflict_signals?: string[];
  same_topic_cluster?: boolean;
  source_thread?: string;
}

/** Options for active recall-first search (`search`). */
export interface TicketSearchOptions {
  /** Free-text search query (string or batch of strings). */
  query: string | readonly string[];
  /** Thread keys the caller is authorized to search. */
  allowedThreads: ReadonlySet<string>;
  /** Optional current thread key (used to populate `source_thread` when ticket comes from another thread). */
  currentThread?: string;
  /** Optional ticket state filter (e.g. `["open"]`, `["completed", "stopped"]`). */
  states?: readonly string[];
  /** Optional excluded ticket ids. */
  excludeTicketIds?: ReadonlySet<string>;
  /** Optional authorization revalidation callback. */
  revalidate?: (ticketId: string) => boolean;
  /** Max results to return (default `8`, clamped to `[1, 20]`). */
  limit?: number;
  /** Minimum score threshold (default `3.0`). */
  minScore?: number;
  /** Reference wall clock in ms (defaults to `Date.now()`). */
  nowMs?: number;
}

/** Result of active recall-first search (`search`). */
export interface TicketSearchResult {
  hits: SearchTicketHit[];
  total: number;
  confidence: RecallConfidence;
}

interface IndexedTicket {
  id: string;
  ticket: TicketWithArtifacts;
  threads: Set<string>;
  artifacts: string[];
  rawAsked: string;
  rawDigest: string;
  askedLen: number;
  updatedMs: number;
  createdMs: number;
  /** Map from indexed term -> 6-bit field bitmask. */
  termMasks: Map<string, number>;
  /** Entity terms present in title or artifacts (for `same_topic_cluster` overlap). */
  topicTerms: Set<string>;
  /** Atomic numeric/version facts indexed by conflict category. */
  numericsByCategory: Map<string, NumericFact[]>;
}

interface ScoredCandidate {
  doc: IndexedTicket;
  score: number;
  cov: number;
  matchedFieldsMask: number;
  matchedEntityGroups: Set<number>;
  matchedStrongEntity: boolean;
  maxMatchedEntityIdf: number;
  hasHighSpecificityUniqueHit: boolean;
  conflictSignals: string[];
  isSameThread: boolean;
  sourceThread?: string;
}

function ticketCardState(ticket: Ticket): string {
  if (ticket.ended !== undefined) {
    return ticket.ended.outcome;
  }
  const stage = ticketStage(ticket);
  switch (stage.kind) {
    case "person":
      return `person/${stage.action}`;
    case "idle":
      return "idle";
    case "working":
      return stage.queued ? "working/queued" : "working";
    case "ended":
      return "ended";
  }
}

function latestNonDroppedReportSummary(ticket: Ticket): string {
  for (let i = ticket.assignments.length - 1; i >= 0; i--) {
    const report = ticket.assignments[i].report;
    if (report !== undefined && report.state !== "dropped") {
      return report.summary;
    }
  }
  return "";
}

function stripArtifactExtForIndex(raw: string): string {
  const parts = raw.split(/[\\/]+/).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return "";
  }
  const last = parts[parts.length - 1].replace(LEADING_INDEX_PREFIX_RE, "").replace(TRAILING_EXT_RE, "");
  if (parts.length === 1) {
    return last;
  }
  return [...parts.slice(0, -1), last].join(" ");
}

function popcount6(mask: number): number {
  let m = mask & 0x3f;
  let count = 0;
  while (m !== 0) {
    m &= m - 1;
    count += 1;
  }
  return count;
}

function maskToFields(mask: number): RecallField[] {
  const fields: RecallField[] = [];
  for (let i = 0; i < FIELD_ORDER.length; i++) {
    const field = FIELD_ORDER[i];
    if ((mask & FIELD_BIT[field]) !== 0) {
      fields.push(field);
    }
  }
  return fields;
}

function parseIsoMs(iso: string, fallback: number): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function versionsCompatible(qCanon: string, dCanon: string): boolean {
  if (qCanon === dCanon) {
    return true;
  }
  // Allow querying a major version like "v2" to match "v2.2" without triggering a conflict.
  if (dCanon.startsWith(`${qCanon}.`) || dCanon.startsWith(`${qCanon}_`) || dCanon.startsWith(`${qCanon}-`)) {
    return true;
  }
  if (qCanon.startsWith(`${dCanon}.`) || qCanon.startsWith(`${dCanon}_`) || qCanon.startsWith(`${dCanon}-`)) {
    return true;
  }
  return false;
}

function detectNumericConflicts(
  queryNumerics: readonly NumericFact[],
  docNumericsByCategory: ReadonlyMap<string, readonly NumericFact[]>,
): { signals: string[]; conflictingCategories: Set<string> } {
  if (queryNumerics.length === 0 || docNumericsByCategory.size === 0) {
    return { signals: [], conflictingCategories: new Set() };
  }

  const queryByCategory = new Map<string, NumericFact[]>();
  for (let i = 0; i < queryNumerics.length; i++) {
    const fact = queryNumerics[i];
    let list = queryByCategory.get(fact.category);
    if (list === undefined) {
      list = [];
      queryByCategory.set(fact.category, list);
    }
    list.push(fact);
  }

  const signals: string[] = [];
  const conflictingCategories = new Set<string>();

  for (const [category, qFacts] of queryByCategory) {
    const dFacts = docNumericsByCategory.get(category);
    if (dFacts === undefined || dFacts.length === 0) {
      continue;
    }

    let hasOverlap = false;
    for (let i = 0; i < qFacts.length && !hasOverlap; i++) {
      const qf = qFacts[i];
      for (let j = 0; j < dFacts.length; j++) {
        const df = dFacts[j];
        if (category === "version") {
          if (versionsCompatible(qf.canonical, df.canonical)) {
            hasOverlap = true;
            break;
          }
        } else if (qf.canonical === df.canonical || qf.numericValue === df.numericValue) {
          hasOverlap = true;
          break;
        }
      }
    }

    if (!hasOverlap) {
      conflictingCategories.add(category);
      signals.push(`${qFacts[0].display} ≠ ${dFacts[0].display}`);
    }
  }

  return { signals, conflictingCategories };
}

function compareCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  const diff = b.score - a.score;
  if (Math.abs(diff) > 1e-9) {
    return diff;
  }
  if (b.doc.ticket.updatedAt !== a.doc.ticket.updatedAt) {
    return b.doc.ticket.updatedAt < a.doc.ticket.updatedAt ? -1 : 1;
  }
  if (b.doc.ticket.createdAt !== a.doc.ticket.createdAt) {
    return b.doc.ticket.createdAt < a.doc.ticket.createdAt ? -1 : 1;
  }
  return a.doc.id < b.doc.id ? -1 : a.doc.id > b.doc.id ? 1 : 0;
}

function computeConfidence(
  list: readonly ScoredCandidate[],
  threshold: number,
): RecallConfidence {
  if (list.length === 0) {
    return "none";
  }
  const s1 = list[0].score;
  const s2 = list.length >= 2 ? list[1].score : 0;
  const r12 = s1 / Math.max(s2, 1e-6);

  if (list.length >= 2 && r12 < 1.35) {
    return "ambiguous";
  }
  if (
    list[0].conflictSignals.length === 0 &&
    s1 >= 1.5 * threshold &&
    (list.length === 1 || r12 >= 1.45)
  ) {
    return "high";
  }
  return "medium";
}

function cardConfidenceAt(
  index: number,
  list: readonly ScoredCandidate[],
  overall: Exclude<RecallConfidence, "none">,
): Exclude<RecallConfidence, "none"> {
  if (index === 0) {
    return overall;
  }
  if (overall === "ambiguous") {
    const ratio = list[0].score / Math.max(list[index].score, 1e-6);
    if (ratio < 1.35) {
      return "ambiguous";
    }
  }
  return "medium";
}

function buildSanitizedCardBase(doc: IndexedTicket): {
  ticket_id: string;
  title: string;
  asked?: string;
  digest?: string;
  artifacts?: string[];
  state: string;
  updated: string;
} {
  const ticket = doc.ticket;
  const out: {
    ticket_id: string;
    title: string;
    asked?: string;
    digest?: string;
    artifacts?: string[];
    state: string;
    updated: string;
  } = {
    ticket_id: ticket.id,
    title: sanitizeCardText(ticket.title, 120),
    state: ticketCardState(ticket),
    updated: clip(ticket.updatedAt, 16),
  };
  const asked = sanitizeCardText(doc.rawAsked, 100);
  if (asked.length > 0) {
    out.asked = asked;
  }
  const digest = sanitizeCardText(doc.rawDigest, 140);
  if (digest.length > 0) {
    out.digest = digest;
  }
  if (doc.artifacts.length > 0) {
    out.artifacts = doc.artifacts.slice(0, 6);
  }
  return out;
}

/**
 * In-memory inverted index and multi-field scorer for historical Neo tickets.
 *
 * Supports incremental `upsert`, `remove`, and `updateThreads` in O(tokens) so 1,000+ tickets
 * can be queried in sub-millisecond P95 latency without SQLite LIKE full-table scans.
 */
export class TicketSearchIndex {
  private readonly docs = new Map<string, IndexedTicket>();
  private readonly postings = new Map<string, Map<string, number>>();
  private totalAskedLen = 0;
  private docsWithAsked = 0;

  constructor(initial?: readonly TicketIndexInput[]) {
    if (initial !== undefined) {
      for (let i = 0; i < initial.length; i++) {
        this.upsert(initial[i]);
      }
    }
  }

  /** Number of tickets currently indexed. */
  get size(): number {
    return this.docs.size;
  }

  /** Whether a ticket with `ticketId` is currently indexed. */
  has(ticketId: string): boolean {
    return this.docs.has(ticketId);
  }

  /** Clear all indexed tickets and inverted postings. */
  clear(): void {
    this.docs.clear();
    this.postings.clear();
    this.totalAskedLen = 0;
    this.docsWithAsked = 0;
  }

  /** Insert or update one ticket in the index. */
  upsert(input: TicketIndexInput): void {
    const ticket = input.ticket;
    if (this.docs.has(ticket.id)) {
      this.remove(ticket.id);
    }

    const rawArtifacts = input.artifacts ?? ticket.artifacts ?? [];
    const artifacts: string[] = [];
    const seenArtifacts = new Set<string>();
    for (let i = 0; i < rawArtifacts.length; i++) {
      const cleaned = sanitizeArtifactName(rawArtifacts[i]);
      if (cleaned.length > 0 && !seenArtifacts.has(cleaned)) {
        seenArtifacts.add(cleaned);
        artifacts.push(cleaned);
      }
    }

    const strippedTitle = stripTemplatesForIndex(ticket.title);
    const strippedDigest = stripTemplatesForIndex(ticket.digest ?? "");
    const strippedAsked = stripTemplatesForIndex(input.asked ?? "");
    const rawReport = latestNonDroppedReportSummary(ticket);
    const strippedReport = stripTemplatesForIndex(rawReport);

    const askedCombined =
      strippedAsked.attachmentNames.length > 0
        ? `${strippedAsked.text} ${strippedAsked.attachmentNames.join(" ")}`.trim()
        : strippedAsked.text;
    const askedForIndex = clip(askedCombined, ASKED_INDEX_MAX_CHARS);
    const reportForIndex = clip(strippedReport.text, REPORT_INDEX_MAX_CHARS);

    const artifactsText = artifacts.map(stripArtifactExtForIndex).join(" ");
    const worktreeParts: string[] = [];
    if (ticket.execution?.name !== undefined && ticket.execution.name.length > 0) {
      worktreeParts.push(ticket.execution.name);
    }
    if (ticket.execution?.directory !== undefined && ticket.execution.directory.length > 0) {
      const base = path.basename(ticket.execution.directory);
      if (base.length > 0) {
        worktreeParts.push(base);
      }
    }
    const worktreeText = worktreeParts.join(" ");

    const termMasks = new Map<string, number>();
    const topicTerms = new Set<string>();
    const numericsByCategory = new Map<string, NumericFact[]>();
    const seenNumericKeys = new Set<string>();

    const indexField = (
      field: RecallField,
      text: string,
      recordNumerics: boolean,
      maxTok = 128,
    ): void => {
      if (text.length === 0) {
        return;
      }
      const tokenized = tokenizeForRecall(text, maxTok);
      const bit = FIELD_BIT[field];
      for (let i = 0; i < tokenized.tokens.length; i++) {
        const tok = tokenized.tokens[i];
        termMasks.set(tok.term, (termMasks.get(tok.term) ?? 0) | bit);
        if (
          (field === "title" || field === "artifacts") &&
          tok.isEntity &&
          !tok.isUnitFallback
        ) {
          topicTerms.add(tok.term);
        }
      }
      if (recordNumerics) {
        for (let i = 0; i < tokenized.numerics.length; i++) {
          const fact = tokenized.numerics[i];
          const key = `${fact.category}:${fact.canonical}`;
          if (seenNumericKeys.has(key)) {
            continue;
          }
          seenNumericKeys.add(key);
          let list = numericsByCategory.get(fact.category);
          if (list === undefined) {
            list = [];
            numericsByCategory.set(fact.category, list);
          }
          list.push(fact);
        }
      }
    };

    // Index primary identifying fields and capture their numeric facts for conflict checks.
    indexField("title", strippedTitle.text, true, 64);
    indexField("artifacts", artifactsText, true, 96);
    indexField("digest", strippedDigest.text, true, 96);
    indexField("asked", askedForIndex, true, 128);
    indexField("worktree", worktreeText, false, 48);
    indexField("reportHead", reportForIndex, false, 96);

    const askedLen = askedForIndex.length;
    if (askedLen > 0) {
      this.totalAskedLen += askedLen;
      this.docsWithAsked += 1;
    }

    const fallbackNow = Date.now();
    const createdMs = parseIsoMs(ticket.createdAt, fallbackNow);
    const updatedMs = parseIsoMs(ticket.updatedAt, createdMs);
    const rawDigest = ticket.digest !== undefined && ticket.digest.length > 0 ? ticket.digest : rawReport;

    const doc: IndexedTicket = {
      id: ticket.id,
      ticket,
      threads: new Set(input.threads),
      artifacts,
      rawAsked: input.asked ?? "",
      rawDigest,
      askedLen,
      updatedMs,
      createdMs,
      termMasks,
      topicTerms,
      numericsByCategory,
    };

    this.docs.set(ticket.id, doc);
    for (const [term, mask] of termMasks) {
      let posting = this.postings.get(term);
      if (posting === undefined) {
        posting = new Map<string, number>();
        this.postings.set(term, posting);
      }
      posting.set(ticket.id, mask);
    }
  }

  /** Remove a ticket from the index. Returns `true` if the ticket existed. */
  remove(ticketId: string): boolean {
    const existing = this.docs.get(ticketId);
    if (existing === undefined) {
      return false;
    }
    this.docs.delete(ticketId);
    if (existing.askedLen > 0) {
      this.totalAskedLen -= existing.askedLen;
      this.docsWithAsked = Math.max(0, this.docsWithAsked - 1);
    }
    for (const term of existing.termMasks.keys()) {
      const posting = this.postings.get(term);
      if (posting !== undefined) {
        posting.delete(ticketId);
        if (posting.size === 0) {
          this.postings.delete(term);
        }
      }
    }
    return true;
  }

  /** Replace the thread keys associated with an already-indexed ticket. */
  updateThreads(ticketId: string, threads: readonly string[]): boolean {
    const existing = this.docs.get(ticketId);
    if (existing === undefined) {
      return false;
    }
    existing.threads = new Set(threads);
    return true;
  }

  /**
   * Precision-first passive recall for candidate cards.
   *
   * Enforces strict empty-return gates, thread/revalidation authorization, numeric conflict suppression,
   * noise-collapse detection, and outputs sanitized cards with NO `matched_snippet`.
   */
  recallForCandidate(options: CandidateRecallOptions): CandidateRecallResult {
    const config = recallConfig();
    if (!config.candidateRelevance || this.docs.size === 0) {
      return { sameThread: [], crossThread: [], confidence: "none" };
    }

    const mergedParts: string[] = [];
    for (let i = 0; i < options.queryTexts.length; i++) {
      const stripped = stripTemplatesForIndex(options.queryTexts[i]);
      if (stripped.text.length > 0) {
        mergedParts.push(stripped.text);
      }
    }
    const mergedQuery = mergedParts.join(" ").trim();
    if (mergedQuery.length === 0) {
      return { sameThread: [], crossThread: [], confidence: "none" };
    }

    const tokenized = tokenizeForRecall(mergedQuery);
    if (tokenized.effectiveLength < 4 || tokenized.entityCount === 0) {
      return { sameThread: [], crossThread: [], confidence: "none" };
    }

    const prepared = this.prepareQueryTokens(tokenized);
    if (prepared.entityGroupCount === 0) {
      return { sameThread: [], crossThread: [], confidence: "none" };
    }

    // Single-entity query whose lone entity is too weak (`idf < 2.2`) returns empty immediately.
    if (prepared.entityGroupCount === 1 && prepared.maxEntityIdf < 2.2) {
      return { sameThread: [], crossThread: [], confidence: "none" };
    }

    const minScoreSame = options.minScoreSame ?? config.minScoreSame;
    const minScoreCross = options.minScoreCross ?? config.minScoreCross;
    const allowCross = options.allowCrossThread ?? config.crossSurface;
    const maxSame = options.maxSameThread ?? 3;
    const maxCross = options.maxCrossThread ?? 2;
    const nowMs = options.nowMs ?? Date.now();

    const scored = this.scoreCandidates(tokenized, prepared, {
      allowedThreads: options.allowedThreads,
      currentThread: options.currentThread,
      allowCrossThread: allowCross,
      excludeTicketIds: options.excludeTicketIds,
      handedBackIds: options.handedBackIds,
      revalidate: options.revalidate,
      nowMs,
      suppressNewTaskConflict: true,
    });

    const samePassing: ScoredCandidate[] = [];
    const crossPassing: ScoredCandidate[] = [];

    for (let i = 0; i < scored.length; i++) {
      const item = scored[i];

      // Ban pure reportHead-only hits in passive recall.
      if (item.matchedFieldsMask === FIELD_BIT.reportHead) {
        continue;
      }

      // Entity hit gates.
      if (prepared.entityGroupCount >= 2) {
        if (item.matchedEntityGroups.size < 2 && !item.matchedStrongEntity) {
          continue;
        }
      } else {
        // Single-entity query must hit a primary metadata field with idf >= 2.5.
        if (
          item.matchedEntityGroups.size < 1 ||
          (item.matchedFieldsMask & STRONG_FIELD_MASK) === 0 ||
          item.maxMatchedEntityIdf < 2.5
        ) {
          continue;
        }
      }

      // Numeric conflict suppression in passive recall.
      if (item.conflictSignals.length > 0) {
        if (tokenized.hasNewTaskIntent) {
          continue;
        }
        if (!item.hasHighSpecificityUniqueHit || item.cov < 0.5) {
          continue;
        }
      }

      if (item.isSameThread) {
        if (item.score >= minScoreSame && item.cov >= 0.35) {
          samePassing.push(item);
        }
      } else if (allowCross) {
        // Cross-thread threshold is strictly enforced and NEVER relaxed when sameThread is empty.
        if (item.score >= minScoreCross && item.cov >= 0.55) {
          crossPassing.push(item);
        }
      }
    }

    samePassing.sort(compareCandidates);
    crossPassing.sort(compareCandidates);

    // Noise-collapse detection: flat smear of >= 5 mediocre hits collapses to empty.
    const sameFiltered = this.applyNoiseCollapse(samePassing, minScoreSame);
    const crossFiltered = this.applyNoiseCollapse(crossPassing, minScoreCross);

    const sameTop = maxSame > 0 ? sameFiltered.slice(0, maxSame) : [];
    const crossTop = maxCross > 0 ? crossFiltered.slice(0, maxCross) : [];

    const sameConf = computeConfidence(sameTop, minScoreSame);
    const crossConf = computeConfidence(crossTop, minScoreCross);
    const overallConfidence = sameTop.length > 0 ? sameConf : crossConf;

    const sameCards: RecalledTicketCard[] =
      sameConf === "none"
        ? []
        : sameTop.map((item, idx) => this.toRecalledCard(item, cardConfidenceAt(idx, sameTop, sameConf), false));

    const crossCards: RecalledTicketCard[] =
      crossConf === "none"
        ? []
        : crossTop.map((item, idx) =>
            this.toRecalledCard(item, cardConfidenceAt(idx, crossTop, crossConf), true),
          );

    return {
      sameThread: sameCards,
      crossThread: crossCards,
      confidence: overallConfidence,
    };
  }

  /**
   * Recall-first active search backing `orchestrator_search`.
   *
   * Uses a looser threshold (`default 3.0`), always enforces `allowedThreads` and `revalidate`,
   * exposes explainability (`score`, `confidence`, `matched_fields`, `conflict_signals`,
   * `same_topic_cluster`), and never dumps raw report bodies or attachment contents.
   */
  search(options: TicketSearchOptions): TicketSearchResult {
    if (this.docs.size === 0) {
      return { hits: [], total: 0, confidence: "none" };
    }
    const rawList = typeof options.query === "string" ? [options.query] : options.query;
    const cleanedParts: string[] = [];
    for (let i = 0; i < rawList.length; i++) {
      const stripped = stripTemplatesForIndex(rawList[i]);
      if (stripped.text.length > 0) {
        cleanedParts.push(stripped.text);
      }
    }
    const mergedQuery = cleanedParts.join(" ").trim();
    if (mergedQuery.length === 0) {
      return { hits: [], total: 0, confidence: "none" };
    }

    const tokenized = tokenizeForRecall(mergedQuery);
    if (tokenized.tokens.length === 0) {
      return { hits: [], total: 0, confidence: "none" };
    }

    const prepared = this.prepareQueryTokens(tokenized);
    const minScore = options.minScore ?? DEFAULT_SEARCH_MIN_SCORE;
    const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 8)));
    const nowMs = options.nowMs ?? Date.now();
    const stateSet =
      options.states !== undefined && options.states.length > 0
        ? new Set(options.states.map((s) => s.toLowerCase()))
        : undefined;

    const scored = this.scoreCandidates(tokenized, prepared, {
      allowedThreads: options.allowedThreads,
      currentThread: options.currentThread,
      allowCrossThread: true,
      excludeTicketIds: options.excludeTicketIds,
      revalidate: options.revalidate,
      nowMs,
      suppressNewTaskConflict: false,
    });

    const passing: ScoredCandidate[] = [];
    for (let i = 0; i < scored.length; i++) {
      const item = scored[i];
      if (item.score < minScore) {
        continue;
      }
      if (prepared.entityGroupCount > 0 && item.matchedEntityGroups.size === 0 && item.conflictSignals.length === 0) {
        continue;
      }
      if (stateSet !== undefined) {
        const ticket = item.doc.ticket;
        const cardSt = ticketCardState(ticket).toLowerCase();
        const isOpen = ticket.ended === undefined;
        const outcome = ticket.ended?.outcome.toLowerCase();
        const matchesState =
          stateSet.has(cardSt) ||
          (isOpen && stateSet.has("open")) ||
          (outcome !== undefined && stateSet.has(outcome));
        if (!matchesState) {
          continue;
        }
      }
      passing.push(item);
    }

    passing.sort(compareCandidates);
    const total = passing.length;
    const top = passing.slice(0, limit);
    const overallConf = computeConfidence(top, Math.max(minScore, DEFAULT_MIN_SCORE_SAME));
    if (overallConf === "none") {
      return { hits: [], total: 0, confidence: "none" };
    }

    const clusterFlags = this.detectSameTopicClusters(top);
    const hits: SearchTicketHit[] = top.map((item, idx) => {
      const base = buildSanitizedCardBase(item.doc);
      const hit: SearchTicketHit = {
        ...base,
        score: Math.round(item.score * 1000) / 1000,
        confidence: cardConfidenceAt(idx, top, overallConf),
        matched_fields: maskToFields(item.matchedFieldsMask),
      };
      if (item.conflictSignals.length > 0) {
        hit.conflict_signals = item.conflictSignals;
      }
      if (clusterFlags[idx]) {
        hit.same_topic_cluster = true;
      }
      if (
        options.currentThread !== undefined &&
        !item.isSameThread &&
        item.sourceThread !== undefined
      ) {
        hit.source_thread = item.sourceThread;
      }
      return hit;
    });

    return {
      hits,
      total,
      confidence: overallConf,
    };
  }

  private computeIdf(df: number): number {
    const n = this.docs.size;
    // Stabilize small corpora (N < 25) so unique terms in fresh stores retain discriminative IDF,
    // while using the exact smoothed IDF formula for N >= 25.
    const nEff = Math.max(n, 25);
    const dfEff = Math.max(df, 1);
    return Math.log(1 + Math.max(0, nEff - dfEff + 0.5) / (dfEff + 0.5));
  }

  private prepareQueryTokens(tokenized: TokenizedRecall): {
    tokens: Array<{
      token: RecallToken;
      df: number;
      idf: number;
      gamma: number;
      isEntity: boolean;
    }>;
    entityGroupWeights: Map<number, number>;
    totalEntityWeight: number;
    entityGroupCount: number;
    maxEntityIdf: number;
  } {
    const n = this.docs.size;
    const preparedTokens: Array<{
      token: RecallToken;
      df: number;
      idf: number;
      gamma: number;
      isEntity: boolean;
    }> = [];
    const entityGroupWeights = new Map<number, number>();
    let maxEntityIdf = 0;

    for (let i = 0; i < tokenized.tokens.length; i++) {
      const token = tokenized.tokens[i];
      const df = this.postings.get(token.term)?.size ?? 0;
      const idf = this.computeIdf(df);
      let gamma = token.weight;
      let isEntity = token.isEntity;

      if (n >= 20) {
        const dfRatio = df / n;
        if (dfRatio > 0.5) {
          gamma = 0;
          isEntity = false;
        } else if (dfRatio > 0.3) {
          gamma = Math.min(gamma, 0.15);
          isEntity = false;
        }
      }

      preparedTokens.push({ token, df, idf, gamma, isEntity });

      if (isEntity && !token.isUnitFallback && gamma > 0) {
        const w = gamma * idf;
        const prev = entityGroupWeights.get(token.groupId) ?? 0;
        if (w > prev) {
          entityGroupWeights.set(token.groupId, w);
        }
        if (idf > maxEntityIdf) {
          maxEntityIdf = idf;
        }
      }
    }

    let totalEntityWeight = 0;
    for (const w of entityGroupWeights.values()) {
      totalEntityWeight += w;
    }

    return {
      tokens: preparedTokens,
      entityGroupWeights,
      totalEntityWeight,
      entityGroupCount: entityGroupWeights.size,
      maxEntityIdf,
    };
  }

  private scoreCandidates(
    tokenized: TokenizedRecall,
    prepared: ReturnType<TicketSearchIndex["prepareQueryTokens"]>,
    opts: {
      allowedThreads: ReadonlySet<string>;
      currentThread?: string;
      allowCrossThread: boolean;
      excludeTicketIds?: ReadonlySet<string>;
      handedBackIds?: ReadonlySet<string>;
      revalidate?: (ticketId: string) => boolean;
      nowMs: number;
      suppressNewTaskConflict: boolean;
    },
  ): ScoredCandidate[] {
    // Collect candidate ticket ids via inverted postings (O(sum df) instead of full scan).
    const candidateIds = new Set<string>();
    for (let i = 0; i < prepared.tokens.length; i++) {
      const item = prepared.tokens[i];
      if (item.gamma <= 0) {
        continue;
      }
      const posting = this.postings.get(item.token.term);
      if (posting === undefined) {
        continue;
      }
      for (const id of posting.keys()) {
        candidateIds.add(id);
      }
    }

    if (candidateIds.size === 0) {
      return [];
    }

    const avgAskedLen = this.docsWithAsked > 0 ? this.totalAskedLen / this.docsWithAsked : 1;
    const results: ScoredCandidate[] = [];

    for (const ticketId of candidateIds) {
      if (opts.excludeTicketIds?.has(ticketId) || opts.handedBackIds?.has(ticketId)) {
        continue;
      }
      const doc = this.docs.get(ticketId);
      if (doc === undefined) {
        continue;
      }

      // Hard thread authorization check: ticket must belong to at least one allowed thread.
      let authorizedThread: string | undefined;
      let isSameThread = false;
      for (const th of doc.threads) {
        if (!opts.allowedThreads.has(th)) {
          continue;
        }
        if (opts.currentThread !== undefined && th === opts.currentThread) {
          isSameThread = true;
          authorizedThread = th;
          break;
        }
        if (authorizedThread === undefined) {
          authorizedThread = th;
        }
      }
      if (authorizedThread === undefined) {
        continue;
      }
      if (!isSameThread && opts.currentThread !== undefined && !opts.allowCrossThread) {
        continue;
      }
      if (opts.revalidate !== undefined && !opts.revalidate(ticketId)) {
        continue;
      }

      const { signals: conflictSignals, conflictingCategories } = detectNumericConflicts(
        tokenized.numerics,
        doc.numericsByCategory,
      );

      const askedNorm =
        doc.askedLen > 0 ? 1 / (0.65 + 0.35 * (doc.askedLen / Math.max(1, avgAskedLen))) : 1.0;

      // Group-deduplicated max-field saturated scoring.
      const groupMaxScore = new Map<number, number>();
      const matchedEntityGroups = new Set<number>();
      let matchedFieldsMask = 0;
      let matchedStrongEntity = false;
      let maxMatchedEntityIdf = 0;
      let hasHighSpecificityUniqueHit = false;

      for (let i = 0; i < prepared.tokens.length; i++) {
        const q = prepared.tokens[i];
        if (q.gamma <= 0) {
          continue;
        }
        const fieldMask = doc.termMasks.get(q.token.term);
        if (fieldMask === undefined || fieldMask === 0) {
          continue;
        }

        const isConflictingFallback =
          q.token.isUnitFallback === true &&
          q.token.conflictCategory !== undefined &&
          conflictingCategories.has(q.token.conflictCategory);

        // Compute max(w_k * L_k) + 0.25 * min(2, matchedFieldCount - 1)
        let maxFieldW = 0;
        if ((fieldMask & FIELD_BIT.title) !== 0) maxFieldW = Math.max(maxFieldW, FIELD_WEIGHT.title);
        if ((fieldMask & FIELD_BIT.artifacts) !== 0) maxFieldW = Math.max(maxFieldW, FIELD_WEIGHT.artifacts);
        if ((fieldMask & FIELD_BIT.digest) !== 0) maxFieldW = Math.max(maxFieldW, FIELD_WEIGHT.digest);
        if ((fieldMask & FIELD_BIT.asked) !== 0) {
          maxFieldW = Math.max(maxFieldW, FIELD_WEIGHT.asked * askedNorm);
        }
        if ((fieldMask & FIELD_BIT.worktree) !== 0) maxFieldW = Math.max(maxFieldW, FIELD_WEIGHT.worktree);
        if ((fieldMask & FIELD_BIT.reportHead) !== 0) maxFieldW = Math.max(maxFieldW, FIELD_WEIGHT.reportHead);

        const fieldCount = popcount6(fieldMask);
        const fieldFactor = maxFieldW + 0.25 * Math.min(2, fieldCount - 1);
        const effGamma = isConflictingFallback ? q.gamma * 0.25 : q.gamma;
        const contrib = effGamma * q.idf * fieldFactor;

        const prevGroup = groupMaxScore.get(q.token.groupId) ?? 0;
        if (contrib > prevGroup) {
          groupMaxScore.set(q.token.groupId, contrib);
        }

        matchedFieldsMask |= fieldMask;

        if (q.isEntity && !isConflictingFallback) {
          matchedEntityGroups.add(q.token.groupId);
          if (q.token.isStrong) {
            matchedStrongEntity = true;
          }
          if (q.idf > maxMatchedEntityIdf) {
            maxMatchedEntityIdf = q.idf;
          }
          const inPrimaryTitleOrArtifact =
            (fieldMask & (FIELD_BIT.title | FIELD_BIT.artifacts)) !== 0;
          const isNonConflictingCategory =
            q.token.conflictCategory === undefined ||
            !conflictingCategories.has(q.token.conflictCategory);
          if (
            inPrimaryTitleOrArtifact &&
            isNonConflictingCategory &&
            q.df === 1 &&
            q.idf >= 3.2 &&
            (q.token.isStrong || q.token.kind === "en" || q.token.term.length >= 3)
          ) {
            hasHighSpecificityUniqueHit = true;
          }
        }
      }

      if (matchedFieldsMask === 0) {
        continue;
      }

      let baseScore = 0;
      for (const gScore of groupMaxScore.values()) {
        baseScore += gScore;
      }

      // Entity coverage over distinct substantive entity groups.
      let matchedEntityWeight = 0;
      for (const gid of matchedEntityGroups) {
        matchedEntityWeight += prepared.entityGroupWeights.get(gid) ?? 0;
      }
      const cov =
        prepared.totalEntityWeight > 0 ? matchedEntityWeight / prepared.totalEntityWeight : 0;

      // Mutual-exclusion numeric conflict penalty (×0.45).
      let score = baseScore;
      if (conflictSignals.length > 0) {
        score *= 0.45;
        if (opts.suppressNewTaskConflict && tokenized.hasNewTaskIntent) {
          score *= 0.35;
        }
      }

      // Status & artifact prior: suppress failed/dropped empty tickets, slightly favor completed deliverables.
      const outcome = doc.ticket.ended?.outcome;
      if ((outcome === "dropped" || outcome === "stopped") && doc.artifacts.length === 0) {
        score *= 0.35;
      } else if (outcome === "completed" && doc.artifacts.length > 0) {
        score *= 1.08;
      }

      // Capped recency micro-adjustment (max +8%, never overwhelms entity relevance).
      const days = Math.max(0, (opts.nowMs - doc.updatedMs) / 86_400_000);
      const timeBoost = 1 + 0.08 * Math.exp(-days / 30);
      score *= timeBoost;

      results.push({
        doc,
        score,
        cov,
        matchedFieldsMask,
        matchedEntityGroups,
        matchedStrongEntity,
        maxMatchedEntityIdf,
        hasHighSpecificityUniqueHit,
        conflictSignals,
        isSameThread,
        sourceThread: isSameThread ? undefined : authorizedThread,
      });
    }

    return results;
  }

  private applyNoiseCollapse(
    passing: readonly ScoredCandidate[],
    minScore: number,
  ): ScoredCandidate[] {
    if (passing.length >= 5) {
      const s1 = passing[0].score;
      const s5 = passing[4].score;
      if (s1 > 0 && s5 / s1 >= 0.8 && s1 < 1.35 * minScore) {
        return [];
      }
    }
    return [...passing];
  }

  private toRecalledCard(
    item: ScoredCandidate,
    confidence: Exclude<RecallConfidence, "none">,
    includeSourceThread: boolean,
  ): RecalledTicketCard {
    const base = buildSanitizedCardBase(item.doc);
    const card: RecalledTicketCard = {
      ...base,
      confidence,
      matched_fields: maskToFields(item.matchedFieldsMask),
    };
    if (item.conflictSignals.length > 0) {
      card.conflict_signals = item.conflictSignals;
    }
    if (includeSourceThread && item.sourceThread !== undefined) {
      card.source_thread = item.sourceThread;
    }
    return card;
  }

  private detectSameTopicClusters(top: readonly ScoredCandidate[]): boolean[] {
    const flags = new Array<boolean>(top.length).fill(false);
    if (top.length < 2) {
      return flags;
    }
    const topScore = top[0].score;
    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) {
        const a = top[i];
        const b = top[j];
        if (Math.abs(a.doc.createdMs - b.doc.createdMs) > CLUSTER_WINDOW_MS) {
          continue;
        }
        if (a.conflictSignals.length > 0 || b.conflictSignals.length > 0) {
          continue;
        }
        // Overlap via shared matched query entity groups or title/artifact entity Jaccard.
        let sharedQueryGroups = 0;
        for (const gid of a.matchedEntityGroups) {
          if (b.matchedEntityGroups.has(gid)) {
            sharedQueryGroups += 1;
          }
        }
        const minGroups = Math.min(a.matchedEntityGroups.size, b.matchedEntityGroups.size);
        const queryOverlap =
          minGroups > 0 &&
          sharedQueryGroups >= Math.min(2, minGroups) &&
          b.score >= 0.45 * topScore;

        let sharedTopic = 0;
        const unionSize = a.doc.topicTerms.size + b.doc.topicTerms.size;
        if (a.doc.topicTerms.size > 0 && b.doc.topicTerms.size > 0) {
          for (const t of a.doc.topicTerms) {
            if (b.doc.topicTerms.has(t)) {
              sharedTopic += 1;
            }
          }
        }
        const jaccard = unionSize > sharedTopic ? sharedTopic / (unionSize - sharedTopic) : 0;

        if (queryOverlap || jaccard >= 0.3) {
          flags[i] = true;
          flags[j] = true;
        }
      }
    }
    return flags;
  }
}
