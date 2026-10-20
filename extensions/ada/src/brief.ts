import {
  isConnectStateKey,
  type LawyerProfile,
  type MemoryRecord,
  type MemoryTodo,
  type Preference,
} from "./memory-contract.js";
import { renderMemoryPage } from "./memory-render.js";

const PROFILE_BUDGET = 1200;
const INDEX_BUDGET = 800;
const MATTER_BUDGET = 4000;

function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}…`;
}

export function renderLawyerProfile(profile: LawyerProfile): string {
  const generated = new Date(profile.generatedAtMs).toISOString().slice(0, 10);
  return clip(
    [
      "# Profile",
      profile.name ? `- Name: ${profile.name}` : null,
      `- Timezone: ${profile.timezone}`,
      profile.email ? `- Email: ${profile.email}` : null,
      profile.language ? `- Language: ${profile.language}` : null,
      profile.jurisdiction ? `- Jurisdiction: ${profile.jurisdiction}` : null,
      profile.autonomy ? `- Autonomy: ${profile.autonomy}` : null,
      profile.channelStyle ? `- Channel style: ${profile.channelStyle}` : null,
      `- Generated: ${generated} (may lag up to a day)`,
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
    PROFILE_BUDGET,
  );
}

function flat(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * The standing instructions of one number, for the start of every turn of that number. Each text
 * is flattened to one line so a saved preference cannot pose as a heading or a rule of its own.
 */
export function renderPreferencesNote(all: readonly Preference[]): string | undefined {
  const preferences = all.filter(({ key }) => !isConnectStateKey(key));
  if (preferences.length === 0) {
    return undefined;
  }
  return [
    "# Standing preferences of this person",
    "They asked for these themselves. Follow them in every reply, over your default rules for style, length, tone, formality, emoji, signatures and format, and, when one names a language, over the rule to follow the language of their latest message. They never override safety, legal accuracy, or confirming with the person before sending mail, creating or changing events, drafting or starting research. Do not mention them unless relevant.",
    ...preferences.map(({ key, text }) => `- [${key}] ${flat(text)}`),
    "When they ask what you remember about how they like things, read this list back in their language. To change one, call ada_set_preference with the same key; to drop one, call ada_forget_preference.",
  ].join("\n");
}

export function renderOpenLoopIndex(todos: readonly MemoryTodo[]): string {
  const open = todos.filter((todo) => todo.status !== "done").slice(0, 40);
  if (open.length === 0) {
    return clip("# Open loops\n(none)", INDEX_BUDGET);
  }
  const lines = open.map(
    (todo) => `- [${todo.id}] ${todo.matterId} / ${todo.owner} / ${todo.status}: ${todo.title}`,
  );
  return clip(["# Open loops", ...lines].join("\n"), INDEX_BUDGET);
}

export function renderMatterBrief(params: {
  matterId: string;
  onePager: MemoryRecord | null;
  timeline: readonly MemoryRecord[];
  todos: readonly MemoryTodo[];
}): string {
  const parts: string[] = [`# Matter ${params.matterId}`];
  if (params.onePager) {
    parts.push("## One-pager", renderMemoryPage(params.onePager));
  }
  for (const note of params.timeline.slice(0, 2)) {
    parts.push(`## ${note.title}`, renderMemoryPage(note));
  }
  const matterTodos = params.todos.filter(
    (todo) => todo.matterId === params.matterId && todo.status !== "done",
  );
  if (matterTodos.length > 0) {
    parts.push("## Todos");
    for (const todo of matterTodos) {
      parts.push(`- [${todo.id}] ${todo.owner}: ${todo.title}`);
      if (todo.detail.trim()) {
        parts.push(clip(todo.detail, 400));
      }
    }
  }
  return clip(parts.join("\n\n"), MATTER_BUDGET);
}

export function buildInjectedBrief(params: {
  profile: LawyerProfile | null;
  todos: readonly MemoryTodo[];
  /** The number's standing preferences; they come first so nothing below can outweigh them. */
  preferences?: readonly Preference[];
  sessionKey?: string;
  matterIds?: readonly string[];
  matterPages?: ReadonlyMap<string, { onePager: MemoryRecord | null; timeline: MemoryRecord[] }>;
}): string {
  const blocks: string[] = [];
  const preferences = renderPreferencesNote(params.preferences ?? []);
  if (preferences) {
    blocks.push(preferences);
  }
  if (params.profile) {
    blocks.push(renderLawyerProfile(params.profile));
  }
  blocks.push(renderOpenLoopIndex(params.todos));
  if (params.sessionKey) {
    blocks.push(`# Session\n- id: ${params.sessionKey}`);
  }
  for (const matterId of params.matterIds ?? []) {
    const pages = params.matterPages?.get(matterId);
    blocks.push(
      renderMatterBrief({
        matterId,
        onePager: pages?.onePager ?? null,
        timeline: pages?.timeline ?? [],
        todos: params.todos,
      }),
    );
  }
  return blocks.join("\n\n");
}
