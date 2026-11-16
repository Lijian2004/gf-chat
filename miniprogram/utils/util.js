/* 通用工具：UTF-8 流式解码、分句、Markdown → rich-text 节点、朗读清洗 */
const app = getApp();

/* ============ 性格元数据（与后端 PERSONALITIES 对应） ============ */
const PERSONALITY_META = {
  gentle: { label: "温柔", emoji: "🌷", desc: "轻声细语，治愈你的每一天" },
  tsundere: { label: "傲娇", emoji: "😤", desc: "口是心非，藏不住对你的喜欢" },
  aloof: { label: "高冷", emoji: "❄️", desc: "话少可靠，偶尔流露温柔" },
  sharp: { label: "犀利", emoji: "⚡", desc: "一针见血，聪明爱吐槽" },
  grumpy: { label: "暴躁", emoji: "🔥", desc: "脾气来得快去得快，其实很在意你" },
  shy: { label: "害羞", emoji: "🌸", desc: "容易脸红，需要你主动一点" },
};

const STORAGE_KEYS = {
  name: "gf_name",
  personality: "gf_personality",
  history: "gf_history",
  greeting: "gf_greeting",
  voice: "gf_voice",
  voicePersona: "gf_voice_persona",
  location: "gf_location",
};
const MAX_SAVED_HISTORY = 60;

/* ============ UTF-8 增量解码（小程序无 TextDecoder，且分块可能切断多字节字符） ============ */
function Utf8StreamDecoder() {
  this.pending = []; // 上一块末尾未解码完的字节
}

Utf8StreamDecoder.prototype.decode = function (buf) {
  const bytes = this.pending.concat(Array.prototype.slice.call(new Uint8Array(buf)));
  this.pending = [];
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let len;
    if (b < 0x80) len = 1;
    else if ((b & 0xe0) === 0xc0) len = 2;
    else if ((b & 0xf0) === 0xe0) len = 3;
    else if ((b & 0xf8) === 0xf0) len = 4;
    else { i += 1; continue; } // 非法字节，跳过
    if (i + len > bytes.length) {
      // 半个多字节字符：留给下一块
      this.pending = bytes.slice(i);
      break;
    }
    let cp = b & (len === 1 ? 0x7f : len === 2 ? 0x1f : len === 3 ? 0x0f : 0x07);
    let ok = true;
    for (let j = 1; j < len; j++) {
      const cb = bytes[i + j];
      if ((cb & 0xc0) !== 0x80) { ok = false; break; }
      cp = (cp << 6) | (cb & 0x3f);
    }
    if (!ok) { i += 1; continue; }
    if (cp > 0xffff) {
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      out += String.fromCharCode(cp);
    }
    i += len;
  }
  return out;
};

/* ============ 分句（与 Web 版 extractSentences 一致） ============ */
function extractSentences(buffer, flush = false) {
  const out = [];
  let start = 0;
  const re = /[。！？!?；;\n～~…]/g;
  let m;
  while ((m = re.exec(buffer))) {
    const seg = buffer.slice(start, m.index + 1).trim();
    if (seg && /[^\s。！？!?；;～~…，,、.]/.test(seg)) out.push(seg);
    start = m.index + 1;
  }
  const rest = buffer.slice(start);
  if (flush && rest.trim()) {
    out.push(rest.trim());
    return { out, rest: "" };
  }
  return { out, rest };
}

/* ============ Markdown → rich-text 节点（代码块/行内代码/粗体/斜体/链接） ============ */
function splitCodeBlocks(md) {
  const segs = [];
  const re = /```(\w*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = re.exec(md))) {
    if (m.index > last) segs.push({ type: "text", text: md.slice(last, m.index) });
    segs.push({ type: "code", lang: m[1], code: m[2] });
    last = re.lastIndex;
  }
  if (last < md.length) segs.push({ type: "text", text: md.slice(last) });
  return segs;
}

function parseInline(text) {
  const nodes = [];
  const re = /`([^`\n]+)`|\*\*([^*]+)\*\*|\*([^*\n]+)\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push({ type: "text", text: text.slice(last, m.index) });
    if (m[1] != null) {
      nodes.push({ name: "span", attrs: { class: "md-code-inline" }, children: [{ type: "text", text: m[1] }] });
    } else if (m[2] != null) {
      nodes.push({ name: "span", attrs: { class: "md-strong" }, children: [{ type: "text", text: m[2] }] });
    } else if (m[3] != null) {
      nodes.push({ name: "span", attrs: { class: "md-em" }, children: [{ type: "text", text: m[3] }] });
    } else if (m[4] != null) {
      nodes.push({ name: "span", attrs: { class: "md-link" }, children: [{ type: "text", text: m[4] }] });
    }
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push({ type: "text", text: text.slice(last) });
  return nodes;
}

function markdownToNodes(md) {
  /* 注意：rich-text 只支持白名单内的 HTML 标签（div/p/span/code…），
     不能用 view/text 这类小程序组件名，否则整个节点被忽略、渲染成空 */
  const nodes = [];
  for (const seg of splitCodeBlocks(md || "")) {
    if (seg.type === "code") {
      const children = [];
      if (seg.lang) {
        children.push({
          name: "div",
          attrs: { class: "md-code-lang" },
          children: [{ type: "text", text: seg.lang }],
        });
      }
      children.push({
        name: "pre",
        attrs: { class: "md-code-body" },
        children: [{ type: "text", text: seg.code }],
      });
      nodes.push({ name: "div", attrs: { class: "md-code" }, children });
    } else {
      for (const line of seg.text.split("\n")) {
        const inline = parseInline(line);
        nodes.push({
          name: "p",
          attrs: { class: "md-p" },
          children: inline.length ? inline : [{ type: "text", text: "" }],
        });
      }
    }
  }
  return nodes;
}

/* 把 Markdown 清洗成适合朗读的纯文本（与 Web 版一致） */
function textForSpeech(md) {
  return (md || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[*#_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* ============ 本地存储 ============ */
function loadState() {
  return {
    name: wx.getStorageSync(STORAGE_KEYS.name) || "",
    personality: PERSONALITY_META[wx.getStorageSync(STORAGE_KEYS.personality)]
      ? wx.getStorageSync(STORAGE_KEYS.personality)
      : "gentle",
    greeting: wx.getStorageSync(STORAGE_KEYS.greeting) || "",
    history: safeParseHistory(wx.getStorageSync(STORAGE_KEYS.history)),
    voice: wx.getStorageSync(STORAGE_KEYS.voice) !== "0",
    voicePersona: wx.getStorageSync(STORAGE_KEYS.voicePersona) || "gentle",
    location: safeParse(wx.getStorageSync(STORAGE_KEYS.location)),
  };
}

function safeParse(v) {
  try {
    return typeof v === "object" && v !== null ? v : null;
  } catch (e) {
    return null;
  }
}

function safeParseHistory(v) {
  const arr = safeParse(v);
  if (!Array.isArray(arr)) return [];
  return arr.filter(
    (m) =>
      m &&
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string" &&
      m.content.trim()
  );
}

module.exports = {
  PERSONALITY_META,
  STORAGE_KEYS,
  MAX_SAVED_HISTORY,
  Utf8StreamDecoder,
  extractSentences,
  markdownToNodes,
  textForSpeech,
  loadState,
};
