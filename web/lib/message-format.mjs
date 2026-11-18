// Zulip message text <-> 상상톡 message fields (docs/p2-contract.md, A3·A4).
// Pure functions: no I/O, so they can be checked without Zulip.
//
// Stored Zulip text (apply_markdown=false) looks like:
//   @_**김도윤|5** [답장](#narrow/near/120):      <- reply prefix (silent mention + link to the original)
//   ```quote
//   앞 80자
//   ```
//   @**이서준|3** 확인 부탁드립니다               <- body with mentions
//   [회의자료.pdf](/user_uploads/2/ab/cd/x.pdf)   <- attachment lines (lib/files.mjs)
// Zulip's own web "Quote and reply" writes the same shape (with "said"/"말했습니다" and a full URL), so
// replies made there are recognised too.
import { splitAttachments } from "./files.mjs";

export const RECALLED_TEXT = "회수된 메시지입니다";
export const EXCERPT_LENGTH = 80;

// Reply prefix at the very start: silent mention, link ending in /near/<id>, then a quote fence of 3+ ` or ~.
const REPLY_PREFIX = /^@_\*\*([^\n]+?)\|(\d+)\*\* \[[^\]\n]*\]\([^)\s]*\/near\/(\d+)\):\n(`{3,}|~{3,})quote\n([\s\S]*?)\n\4[ \t]*(?:\n|$)/;
// @**이름|id** (notifies), @_**이름|id** (silent), @**all** etc. The id part is optional (older Zulip web).
const MENTION = /@(_?)\*\*([^*\n|]+?)(?:\|(\d+))?\*\*/g;

// Splits raw Zulip text into its three parts, keeping each raw so an edit can rebuild the message.
export function splitRaw(raw) {
  let text = typeof raw === "string" ? raw : "";
  let prefix = "";
  let reply = null;
  const match = text.match(REPLY_PREFIX);
  if (match) {
    prefix = match[0].endsWith("\n") ? match[0] : `${match[0]}\n`;
    reply = { id: Number(match[3]), senderName: match[1].trim(), excerpt: excerptOf(match[5]), recalled: false };
    text = text.slice(match[0].length);
  }
  const bodyLines = [];
  const fileLines = [];
  for (const line of text.split("\n")) {
    const one = splitAttachments(line);
    if (one.attachments.length === 1 && !one.content) fileLines.push(line.trim());
    else bodyLines.push(line);
  }
  return { prefix, reply, body: bodyLines.join("\n").trim(), fileLines };
}

// "@**김도윤|5** 안녕" -> "@김도윤 안녕"
export function displayText(body) {
  return String(body || "").replace(MENTION, (_, _silent, name) => `@${name.trim()}`);
}

// Ids of people mentioned with notification (silent mentions and wildcards are not listed).
export function mentionIds(body) {
  const ids = [];
  for (const match of String(body || "").matchAll(MENTION)) {
    const id = Number(match[3]);
    if (!match[1] && Number.isSafeInteger(id) && id > 0 && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// One line, at most EXCERPT_LENGTH characters, mentions shown as "@이름", file links as "[파일] 이름".
export function excerptOf(text) {
  const { body, fileLines } = splitRaw(String(text || "").replace(REPLY_PREFIX, ""));
  const plain = displayText(body).replace(/\s+/g, " ").trim();
  if (plain === RECALLED_TEXT) return RECALLED_TEXT;
  if (plain) return plain.length > EXCERPT_LENGTH ? `${plain.slice(0, EXCERPT_LENGTH)}…` : plain;
  const file = fileLines.length ? splitAttachments(fileLines[0]).attachments[0] : null;
  return file ? `[파일] ${file.name}` : "";
}

// Silent mention + link + quote of the original's excerpt. The excerpt is one line and the fence is
// longer than any backtick run in it, so it cannot close the quote early. Names may not contain
// "*" or "|" (Zulip would not parse them either).
export function replyPrefix(original) {
  const name = String(original.senderName || "").replace(/[*|\n]/g, " ").trim() || "알 수 없음";
  const excerpt = excerptOf(original.rawContent ?? original.content ?? "") || " ";
  const longest = Math.max(0, ...[...excerpt.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `@_**${name}|${original.senderId}** [답장](#narrow/near/${original.id}):\n${fence}quote\n${excerpt}\n${fence}\n`;
}

// "@김도윤 보세요" + mentions [5] -> "@**김도윤|5** 보세요". Longer names first so "@김도윤" is not
// eaten by a "@김도" rule. A mentioned person whose "@이름" is not in the text is put in front.
export function applyMentions(text, people) {
  let out = String(text || "");
  const sorted = [...people].sort((a, b) => b.fullName.length - a.fullName.length);
  const missing = [];
  for (const person of sorted) {
    const name = String(person.fullName || "").replace(/[*|\n]/g, " ").trim();
    if (!name) continue;
    const syntax = `@**${name}|${person.userId}**`;
    // "@**이름|id**" already written never contains "@이름", so it is left alone.
    let found = false;
    out = out.replace(new RegExp(escapeRegExp(`@${name}`), "g"), () => {
      found = true;
      return syntax;
    });
    if (!found) missing.push(syntax);
  }
  return missing.length ? `${missing.join(" ")} ${out}`.trim() : out;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A recalled message is an edited one whose text is exactly RECALLED_TEXT. File lines stay in Zulip
// (so the files are not cleaned up as unclaimed) but are never shown.
export function isRecalled(parts, edited) {
  return Boolean(edited) && displayText(parts.body).trim() === RECALLED_TEXT;
}

// Fields shared by every message the server returns (the rest of normalize() lives in server.mjs).
// flags: Zulip's per-user flags for this message (["read", "starred", "mentioned", ...]).
export function messageFields(raw, { edited, flags = [], myId }) {
  const parts = splitRaw(raw);
  const recalled = isRecalled(parts, edited);
  const wildcard = flags.includes("stream_wildcard_mentioned") || flags.includes("topic_wildcard_mentioned") || flags.includes("wildcard_mentioned");
  const mentions = recalled ? [] : mentionIds(parts.body);
  const files = splitAttachments(parts.fileLines.join("\n")).attachments;
  return {
    content: recalled ? RECALLED_TEXT : displayText(parts.body),
    attachments: recalled ? [] : files,
    edited: Boolean(edited),
    recalled,
    replyTo: recalled ? null : parts.reply,
    mentions,
    mentionedMe: !recalled && (flags.includes("mentioned") || wildcard || mentions.includes(myId)),
    starred: flags.includes("starred"),
  };
}

// ---- C5: Zulip /poll and /todo widgets ----
// The first "widget" submessage holds the setup; later ones are votes / strikes in order.
// Keys are Zulip's own (web app compatible): poll options "canned,<n>" (added ones "<sender>,<n>"),
// todo items "<n>,canned" (added ones "<n>,<sender>").
function submessageData(sub) {
  try {
    const data = JSON.parse(sub.content);
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

export function widgetFields(submessages) {
  const list = Array.isArray(submessages) ? [...submessages].sort((a, b) => a.id - b.id) : [];
  const first = list.find((sub) => sub.msg_type === "widget");
  const setup = first ? submessageData(first) : null;
  if (!setup) return { poll: null, todo: null };
  const later = list.filter((sub) => sub !== first && sub.msg_type === "widget");
  if (setup.widget_type === "poll") {
    let question = String(setup.extra_data?.question || "");
    const options = new Map();
    (Array.isArray(setup.extra_data?.options) ? setup.extra_data.options : []).forEach((text, index) => {
      options.set(`canned,${index}`, { key: `canned,${index}`, text: String(text), voters: new Set() });
    });
    for (const sub of later) {
      const data = submessageData(sub);
      if (!data) continue;
      if (data.type === "vote" && options.has(data.key)) {
        if (data.vote === 1) options.get(data.key).voters.add(sub.sender_id);
        if (data.vote === -1) options.get(data.key).voters.delete(sub.sender_id);
      } else if (data.type === "new_option" && typeof data.option === "string") {
        const key = `${sub.sender_id},${data.idx}`;
        if (!options.has(key)) options.set(key, { key, text: data.option, voters: new Set() });
      } else if (data.type === "question" && typeof data.question === "string" && sub.sender_id === first.sender_id) {
        question = data.question;
      }
    }
    const poll = {
      question,
      options: [...options.values()].map((option) => ({ key: option.key, text: option.text, voterIds: [...option.voters].sort((a, b) => a - b) })),
    };
    return { poll, todo: null };
  }
  if (setup.widget_type === "todo") {
    let title = String(setup.extra_data?.task_list_title || "");
    const items = new Map();
    const textOf = (task, desc) => (desc ? `${task}: ${desc}` : String(task || ""));
    (Array.isArray(setup.extra_data?.tasks) ? setup.extra_data.tasks : []).forEach((task, index) => {
      items.set(`${index},canned`, { key: `${index},canned`, text: textOf(task?.task, task?.desc), done: false, doneBy: null });
    });
    for (const sub of later) {
      const data = submessageData(sub);
      if (!data) continue;
      if (data.type === "strike" && items.has(data.key)) {
        const item = items.get(data.key);
        item.done = !item.done;
        item.doneBy = item.done ? sub.sender_id : null;
      } else if (data.type === "new_task" && typeof data.task === "string") {
        const key = `${data.key},${sub.sender_id}`;
        if (!items.has(key)) items.set(key, { key, text: textOf(data.task, data.desc), done: Boolean(data.completed), doneBy: data.completed ? sub.sender_id : null });
      } else if (data.type === "new_task_list_title" && typeof data.title === "string" && sub.sender_id === first.sender_id) {
        title = data.title;
      }
    }
    return { poll: null, todo: { title, items: [...items.values()] } };
  }
  return { poll: null, todo: null };
}

// Zulip text that makes the widget (zerver/lib/widget.py): first line "/poll 질문" or "/todo 제목",
// then one option / task per line. Lines are single-line already (the server checks).
export function widgetContent({ poll, todo }) {
  if (poll) return [`/poll ${poll.question}`, ...poll.options].join("\n");
  return [`/todo ${todo.title}`, ...todo.items].join("\n");
}

// Zulip mention / quote syntax typed by the user ("@**이름**", "@_**이름|5**", "@*그룹*", "@**all**")
// is broken with a zero-width space, so only mentions checked by the server (applyMentions) notify
// anyone and only replyToId makes a reply quote.
export function neutralizeSyntax(text) {
  return String(text || "").replace(/@(_?)\*/g, "@\u200B$1*");
}
