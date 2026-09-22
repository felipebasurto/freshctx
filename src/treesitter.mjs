import { fileURLToPath } from "node:url";

import { Language, Parser } from "../vendor/treesitter/web-tree-sitter.mjs";

const LANGUAGE_BY_EXTENSION = new Map([
  [".py", "python"],
  [".js", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".jsx", "javascript"],
  [".ts", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".tsx", "tsx"],
  [".go", "go"],
  [".rs", "rust"],
]);

const GRAMMAR_FILE = Object.freeze({
  python: "tree-sitter-python.wasm",
  javascript: "tree-sitter-javascript.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm",
});

const DECLARATION_KIND = new Map([
  ["class_definition", "class"],
  ["class_declaration", "class"],
  ["abstract_class_declaration", "class"],
  ["function_definition", "function"],
  ["function_declaration", "function"],
  ["generator_function_declaration", "function"],
  ["function_item", "function"],
  ["method_definition", "method"],
  ["method_declaration", "method"],
]);
const DECLARATION_TYPES = [...DECLARATION_KIND.keys()];
const SCOPE_KIND = new Map([...DECLARATION_KIND, ["impl_item", "class"]]);

const BLOCK_TYPES = new Map([
  ["if_statement", "if"],
  ["if_expression", "if"],
  ["elif_clause", "elif"],
  ["else_clause", "else"],
  ["for_statement", "for"],
  ["for_in_statement", "for"],
  ["for_expression", "for"],
  ["while_statement", "while"],
  ["while_expression", "while"],
  ["loop_expression", "loop"],
  ["with_statement", "with"],
  ["match_statement", "match"],
  ["match_expression", "match"],
  ["case_clause", "case"],
  ["match_arm", "case"],
  ["try_statement", "try"],
  ["except_clause", "except"],
  ["catch_clause", "except"],
  ["finally_clause", "finally"],
  ["switch_statement", "switch"],
  ["expression_switch_statement", "switch"],
  ["type_switch_statement", "switch"],
  ["switch_case", "case"],
]);

export const supportedLanguages = Object.freeze([...new Set(LANGUAGE_BY_EXTENSION.values())]);

let runtimeReady = null;
const parsers = new Map();

function vendorPath(file) {
  return fileURLToPath(new URL(`../vendor/treesitter/${file}`, import.meta.url));
}

function parserFor(language) {
  if (!parsers.has(language)) {
    runtimeReady ??= Parser.init({ locateFile: () => vendorPath("tree-sitter.wasm") });
    parsers.set(language, runtimeReady
      .then(() => Language.load(vendorPath(GRAMMAR_FILE[language])))
      .then((grammar) => new Parser().setLanguage(grammar)));
  }
  return parsers.get(language);
}

function scopeKind(node) {
  const kind = SCOPE_KIND.get(node.type) ?? null;
  if (kind !== "function") return kind;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (SCOPE_KIND.get(parent.type) === "class") return "method";
  }
  return kind;
}

function scopeName(node) {
  return node.childForFieldName(node.type === "impl_item" ? "type" : "name")?.text ?? null;
}

function siblingIndex(node) {
  const siblings = node.parent.namedChildren.filter((child) => child.type === node.type);
  return siblings.length < 2 ? null : siblings.findIndex((child) => child.equals(node));
}

function enclosingSelector(node) {
  const segments = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    const kind = scopeKind(parent);
    const name = kind && scopeName(parent);
    if (name) {
      segments.push(`${kind} ${name}`);
      continue;
    }
    const block = BLOCK_TYPES.get(parent.type);
    if (block) {
      const index = siblingIndex(parent);
      segments.push(index === null ? block : `${block}@${index}`);
    }
  }
  return segments.reverse();
}

function qualifiedSelector(node, name, kind) {
  const segments = enclosingSelector(node);
  const receiver = node.type === "method_declaration"
    ? node.childForFieldName("receiver")?.descendantsOfType("type_identifier")[0]?.text
    : null;
  if (receiver && !segments.includes(`class ${receiver}`)) segments.unshift(`class ${receiver}`);
  segments.push(`${kind} ${name}`);
  return segments.join("::");
}

function utf8Offsets(text, indices) {
  const offsets = new Map();
  let previous = 0;
  let bytes = 0;
  for (const index of [...new Set(indices)].sort((left, right) => left - right)) {
    bytes += Buffer.byteLength(text.slice(previous, index), "utf8");
    offsets.set(index, bytes);
    previous = index;
  }
  return offsets;
}

export async function parseUnits({ path: sourcePath, text }) {
  const name = sourcePath.slice(sourcePath.lastIndexOf("/") + 1).toLowerCase();
  const language = LANGUAGE_BY_EXTENSION.get(name.slice(name.lastIndexOf(".")));
  if (!language) return { status: "unsupported", units: [] };
  let tree;
  try {
    tree = (await parserFor(language)).parse(text);
    if (!tree || tree.rootNode.hasError) return { status: "broken", units: [] };
    const declarations = tree.rootNode.descendantsOfType(DECLARATION_TYPES);
    const offsets = utf8Offsets(text, declarations.flatMap((node) => [node.startIndex, node.endIndex]));
    const units = [];
    for (const node of declarations) {
      const name = scopeName(node);
      if (!name) continue;
      units.push({
        selector: qualifiedSelector(node, name, scopeKind(node)),
        startByte: offsets.get(node.startIndex),
        endByte: offsets.get(node.endIndex),
      });
    }
    const counts = new Map();
    for (const unit of units) counts.set(unit.selector, (counts.get(unit.selector) ?? 0) + 1);
    return { status: "ok", units: units.filter((unit) => counts.get(unit.selector) === 1) };
  } catch {
    return { status: "broken", units: [] };
  } finally {
    tree?.delete();
  }
}

export async function verifyTreeSitterAssets() {
  await Promise.all(supportedLanguages.map(parserFor));
  return [...supportedLanguages];
}
