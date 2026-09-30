import { createBundledHighlighter } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

// @pierre/diffs asks Shiki for languages by name at runtime. The upstream
// `shiki` entry imports its complete 600+ language registry, which makes the
// required single-file MCP resource unnecessarily large. Bundle the common
// source formats used in Kontrol workspaces; @pierre/diffs returns `text` for
// unknown extensions, so those remain readable without a grammar.
const bundledLanguages = {
  javascript: () => import("shiki/langs/javascript"),
  typescript: () => import("shiki/langs/typescript"),
  tsx: () => import("shiki/langs/tsx"),
  jsx: () => import("shiki/langs/jsx"),
  json: () => import("shiki/langs/json"),
  jsonc: () => import("shiki/langs/jsonc"),
  css: () => import("shiki/langs/css"),
  html: () => import("shiki/langs/html"),
  markdown: () => import("shiki/langs/markdown"),
  python: () => import("shiki/langs/python"),
  rust: () => import("shiki/langs/rust"),
  go: () => import("shiki/langs/go"),
  java: () => import("shiki/langs/java"),
  c: () => import("shiki/langs/c"),
  cpp: () => import("shiki/langs/cpp"),
  ruby: () => import("shiki/langs/ruby"),
  sql: () => import("shiki/langs/sql"),
  yaml: () => import("shiki/langs/yaml"),
  yml: () => import("shiki/langs/yml"),
  toml: () => import("shiki/langs/toml"),
  zsh: () => import("shiki/langs/zsh"),
  dockerfile: () => import("shiki/langs/dockerfile"),
  makefile: () => import("shiki/langs/makefile"),
  xml: () => import("shiki/langs/xml"),
  vue: () => import("shiki/langs/vue"),
  svelte: () => import("shiki/langs/svelte"),
  php: () => import("shiki/langs/php"),
  swift: () => import("shiki/langs/swift"),
  kotlin: () => import("shiki/langs/kotlin"),
  scala: () => import("shiki/langs/scala"),
  lua: () => import("shiki/langs/lua"),
  elixir: () => import("shiki/langs/elixir"),
  erlang: () => import("shiki/langs/erlang"),
  haskell: () => import("shiki/langs/haskell"),
  ocaml: () => import("shiki/langs/ocaml"),
  protobuf: () => import("shiki/langs/protobuf"),
  graphql: () => import("shiki/langs/graphql"),
  tf: () => import("shiki/langs/tf"),
  hcl: () => import("shiki/langs/hcl"),
};

const bundledThemes = {};

export * from "shiki/core";
export { createJavaScriptRegexEngine } from "shiki/engine/javascript";
export { createOnigurumaEngine } from "shiki/engine/oniguruma";
export { bundledLanguages, bundledThemes };
export const createHighlighter = createBundledHighlighter({
  langs: bundledLanguages,
  themes: bundledThemes,
  engine: () => createJavaScriptRegexEngine(),
});
