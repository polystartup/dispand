import { readFileSync } from "node:fs";
import ts from "typescript";

// How the guard tests read source code (where the engine calls an adapter, what launches a process,
// who reads a person's rows): by its tokens and its syntax tree, never by its lines, so formatting
// changes nothing they see. A guard finds its candidates as runs of tokens (`match`), the ones its
// former line regex matched whatever the whitespace, line breaks and comments between them; places
// each in the tree (`owner`, `callOf`, `declares`), failing on one it can't place; and compares the
// code it lists with the site's by `shape`, which leaves formatting out.

/** A file parsed, with its parents set. */
export function parse(path: string, text = readFileSync(path, "utf8")): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}

/** The one statement `code` holds, parsed as in an async method (`await`, `return` and `this` read as there). */
export function statement(code: string): ts.Statement {
  const text = `async function _() {\n${code}\n}`;
  const body = (parse("code.ts", text).statements[0] as ts.FunctionDeclaration).body!.statements;
  if (ts.transpileModule(text, { reportDiagnostics: true }).diagnostics?.length || body.length !== 1) throw new Error(`not one statement: ${code}`);
  return body[0]!;
}

/** `file:line:column` of `node`, for a guard's message. */
export function where(node: ts.Node): string {
  const source = node.getSourceFile();
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${source.fileName}:${line + 1}:${character + 1}`;
}

const isDoc = (node: ts.Node) => node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;
/** Its children, every token included (`getChildren`), doc comments aside. */
const children = (node: ts.Node) => node.getChildren().filter((child) => !isDoc(child) && child.kind !== ts.SyntaxKind.EndOfFileToken);

const LEAVES = new WeakMap<ts.Node, { tokens: ts.Node[]; texts: string[] }>();
function leaves(node: ts.Node) {
  let found = LEAVES.get(node);
  if (!found) {
    const tokens: ts.Node[] = [];
    const visit = (n: ts.Node) => {
      const kids = children(n);
      if (kids.length) kids.forEach(visit);
      else if (n.kind !== ts.SyntaxKind.SyntaxList) tokens.push(n);
    };
    visit(node);
    found = { tokens, texts: tokens.map((t) => t.getText()) };
    LEAVES.set(node, found);
  }
  return found;
}

/** `node`'s tokens in order, comments aside: each a node of the tree (a name, a keyword, a literal) or a punctuation token whose parent is the node it belongs to. */
export function tokens(node: ts.Node): ts.Node[] {
  return leaves(node).tokens;
}

/** One token of a pattern: its text, one of several texts, or a test; `optional(step)` may be absent. */
export type Step = string | readonly string[] | ((token: ts.Node) => boolean) | { optional: Step };
export const optional = (step: Step): Step => ({ optional: step });
/** A token naming one of `names`: an identifier, or a `#private` one without its `#`. */
export const named =
  (...names: string[]) =>
  (token: ts.Node): boolean =>
    (ts.isIdentifier(token) || ts.isPrivateIdentifier(token)) && names.includes(token.text.replace(/^#/, ""));

/**
 * Each run of `node`'s tokens that `pattern` matches: what a line regex over those tokens matched,
 * whatever the whitespace, line breaks and comments between them, and never text in a string or a
 * comment.
 */
export function match(node: ts.Node, pattern: readonly Step[]): ts.Node[][] {
  const { tokens: all, texts } = leaves(node);
  const is = (step: Step, i: number): boolean =>
    typeof step === "string" ? texts[i] === step : typeof step === "function" ? step(all[i]!) : Array.isArray(step) && step.includes(texts[i]!);
  const from = (i: number, p: number): ts.Node[] | undefined => {
    if (p === pattern.length) return [];
    const step = pattern[p]!;
    const optional = typeof step === "object" && "optional" in step;
    const rest = i < all.length && is(optional ? step.optional : step, i) ? from(i + 1, p + 1) : undefined;
    return rest ? [all[i]!, ...rest] : optional ? from(i, p + 1) : undefined;
  };
  return all.flatMap((_, i) => {
    const run = from(i, 0);
    return run ? [run] : [];
  });
}

type Wrapper = ts.ParenthesizedExpression | ts.AsExpression | ts.SatisfiesExpression | ts.NonNullExpression | ts.TypeAssertion;
const wraps = (node: ts.Node): node is Wrapper =>
  ts.isParenthesizedExpression(node) ||
  ts.isAsExpression(node) ||
  ts.isSatisfiesExpression(node) ||
  ts.isNonNullExpression(node) ||
  ts.isTypeAssertionExpression(node);

/** `node` as the value it is: inside its parentheses, `as`, `satisfies`, `!`, `<T>` and a spread's `...`. */
export function unwrap(node: ts.Node): ts.Node {
  while (wraps(node) || ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) node = node.expression;
  return node;
}

/** `node`'s text when it is a string literal (unwrapped). Anything else, an identifier included, is none: a guard that needs a literal fails on it. */
export function literal(node: ts.Node | undefined): string | undefined {
  const value = node && unwrap(node);
  return value && ts.isStringLiteralLike(value) ? value.text : undefined;
}

/** When `node` is `this.a.b` (through `?.`, `!`, parentheses and `as`): its `this`, and the names after it without their `#` (`["a", "b"]`). */
export function onThis(node: ts.Node): { self: ts.Node; names: string[] } | undefined {
  const names: string[] = [];
  let n = unwrap(node);
  for (; ts.isPropertyAccessExpression(n); n = unwrap(n.expression)) names.unshift(n.name.text.replace(/^#/, ""));
  return n.kind === ts.SyntaxKind.ThisKeyword ? { self: n, names } : undefined;
}

/** The call whose callee `name` (a token) names: `f(`, `a.f(`, `this.#f(`, `a?.f(`, `f!(`, `f?.(`, `(f as F)(`, `new f(`. */
export function callOf(name: ts.Node): ts.CallExpression | ts.NewExpression | undefined {
  let callee: ts.Node = ts.isPropertyAccessExpression(name.parent) && name.parent.name === name ? name.parent : name;
  while (wraps(callee.parent)) callee = callee.parent;
  const call = callee.parent;
  return (ts.isCallExpression(call) || ts.isNewExpression(call)) && call.expression === callee ? call : undefined;
}

/** The function or method `name` (a token) declares: `function f(`, `const g = function f(`, `f() {`, `#f() {`. */
export function declares(name: ts.Node): ts.FunctionDeclaration | ts.FunctionExpression | ts.MethodDeclaration | ts.MethodSignature | undefined {
  const declaration = name.parent;
  const kind =
    ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration) || ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration);
  return kind && declaration.name === name ? declaration : undefined;
}

const FUNCTION = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.ClassStaticBlockDeclaration,
]);
/** Declarations whose name is in a path (a function expression's own name is not: it is no name around it). */
const NAMED = new Set([
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.EnumMember,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.ShorthandPropertyAssignment,
]);

/** A name as a path reads it: its `#` kept, its quotes and layout dropped. */
function nameText(name: ts.Node): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return tokens(name)
    .map((t) => t.getText())
    .join("");
}

/**
 * The declaration `node` is in, and its path: the declarations around it from the top (a class and
 * its member, a function, the variables and object properties holding a function, an array's
 * element by its index), down to its outermost function: `Engine.launch`, `Engine.#keep`,
 * `Engine.static create`, `Engine.get refused`,
 * `NO_TURN`, `tools.create.run`, `INBOX_TOOLS[1].run`. A declaration's own name is not around it
 * (`codexInputId:` in `NO_TURN` is in `NO_TURN`), but a declaration given as `node` is in its own
 * path. Undefined outside any declaration: a guard can't place it, and fails.
 */
export function owner(node: ts.Node): { path: string; node: ts.Node } | undefined {
  const around: [ts.Node, ts.Node | undefined][] = [];
  for (let n = node, child: ts.Node | undefined; !ts.isSourceFile(n); child = n, n = n.parent) around.unshift([n, child]);
  let path = "";
  let at: ts.Node | undefined;
  for (const [n, child] of around) {
    const name = (n as { name?: ts.Node }).name;
    const segment = ts.isConstructorDeclaration(n)
      ? ".constructor"
      : ts.isArrayLiteralExpression(n)
        ? `[${n.elements.indexOf(child as ts.Expression)}]`
        : NAMED.has(n.kind) && name && name !== child
          ? `.${kindOf(n)}${nameText(name)}`
          : undefined;
    if (segment !== undefined) {
      path += segment;
      at = n;
    }
    if (FUNCTION.has(n.kind)) return path ? { path: path.replace(/^\./, ""), node: n } : undefined;
  }
  return at && { path: path.replace(/^\./, ""), node: at };
}

/** What sets a member apart from another of its name: `static`, `get`, `set`. */
function kindOf(n: ts.Node): string {
  const isStatic = ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
  return `${isStatic ? "static " : ""}${ts.isGetAccessorDeclaration(n) ? "get " : ts.isSetAccessorDeclaration(n) ? "set " : ""}`;
}

/** The statement `node` is in, whole: an `if` without braces keeps its condition. */
export function statementOf(node: ts.Node): ts.Node {
  return ts.findAncestor(node, (n) => ts.isBlock(n.parent) || ts.isSourceFile(n.parent) || ts.isCaseOrDefaultClause(n.parent) || ts.isModuleBlock(n.parent))!;
}

/** Tokens that hold no code: parentheses (a `ParenthesizedExpression` keeps those that matter), a list's separators, the `;` or `,` ending a statement or a member, a stray `;` among statements or members. */
function layout(child: ts.Node, parent: ts.Node, last: boolean): boolean {
  switch (child.kind) {
    case ts.SyntaxKind.OpenParenToken:
    case ts.SyntaxKind.CloseParenToken:
    case ts.SyntaxKind.SemicolonClassElement:
      return true;
    case ts.SyntaxKind.EmptyStatement:
      return parent.kind === ts.SyntaxKind.SyntaxList;
    case ts.SyntaxKind.BarToken:
    case ts.SyntaxKind.AmpersandToken:
      return parent.kind === ts.SyntaxKind.SyntaxList;
    case ts.SyntaxKind.CommaToken:
      return parent.kind === ts.SyntaxKind.SyntaxList || last;
    case ts.SyntaxKind.SemicolonToken:
      // A mapped type's `;` (`{ [K in T]: V; }`) is printed only when the type breaks across lines.
      return last || parent.kind === ts.SyntaxKind.MappedType;
  }
  return false;
}

/**
 * `node`'s code without its formatting: whitespace, line breaks, comments, semicolons, trailing
 * commas, parentheses that change nothing, a string's quotes (`'…'` or `"…"`), how a number is
 * spelled, and quoted or bare property names. Names (with their `#`), literal values, operators and
 * structure stay: two shapes are equal when the code is the same but for its layout. It reads syntax,
 * not meaning: the same work written another way (`a.b` and `a["b"]`) is another shape.
 */
export function shape(node: ts.Node): string {
  // Syntax that holds no code is left out, and what it decided is kept on the nodes instead: whether
  // a node is in an optional chain (`(a?.b).c` throws where `a?.b.c` doesn't), and whether a string
  // is a directive (`"use strict"`, which `("use strict")` or a `;` before it is not).
  if (ts.isParenthesizedExpression(node)) return shape(node.expression);
  if (ts.isParenthesizedTypeNode(node)) return shape(node.type);
  // `type T = | A`, as written before formatting drops its `|`, is `type T = A`.
  if ((ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) && node.types.length === 1) return shape(node.types[0]!);
  const holder = node.parent as { name?: ts.Node; propertyName?: ts.Node } | undefined;
  const isName = (holder?.name === node || holder?.propertyName === node) && !ts.isModuleDeclaration(node.parent);
  // A string is its value; a directive is its text inside its quotes, as an escape keeps a string from being one.
  if (ts.isStringLiteral(node)) return isName ? node.text : directive(node) ? `Directive(${node.getText().slice(1, -1)})` : JSON.stringify(node.text);
  if (ts.isNumericLiteral(node)) return String(Number(node.text));
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  // An array's hole (`[a, , b]`) has no text: it is its kind.
  if (ts.isOmittedExpression(node)) return "OmittedExpression";
  const kids = children(node);
  // A token as written: a keyword, an operator, a template's parts with their backslashes (`String.raw` reads them).
  if (!kids.length) return node.getText();
  const kept = kids
    .filter((child, i) => !layout(child, node, i === kids.length - 1))
    .map(shape)
    .filter(Boolean);
  // A list left empty (`new A` and `new A()`, `{}` and `{;}`) is none.
  if (node.kind === ts.SyntaxKind.SyntaxList && !kept.length) return "";
  return `${ts.SyntaxKind[node.kind]}${ts.isOptionalChain(node) ? "?." : ""}(${kept.join(" ")})`;
}

/** Whether `node` is a directive: a string statement of a file's or a function's prologue, the strings alone that start it. */
function directive(node: ts.StringLiteral): boolean {
  const statement = node.parent;
  const body = statement.parent;
  if (!ts.isExpressionStatement(statement) || !(ts.isSourceFile(body) || (ts.isBlock(body) && ts.isFunctionLike(body.parent)))) return false;
  const before = body.statements.slice(0, body.statements.indexOf(statement) + 1);
  return before.every((s) => ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression));
}

const signed = (node: ts.Node): node is ts.FunctionDeclaration | ts.MethodDeclaration | ts.MethodSignature =>
  ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node);

/** A site's code as it is listed: a function or method by its signature (its modifiers, name, type parameters, parameters and type), its body left out; anything else whole. */
function listing(node: ts.Node): string {
  if (!signed(node)) return shape(node);
  const star = (node as { asteriskToken?: ts.Node }).asteriskToken;
  const parts: (readonly (ts.Node | undefined)[] | undefined)[] = [
    node.modifiers,
    [star],
    [node.name],
    [node.questionToken],
    node.typeParameters,
    node.parameters,
    [node.type],
  ];
  return parts.map((part) => (part ?? []).map((n) => (n ? shape(n) : "")).join(" ")).join(" | ");
}

/**
 * The site a name and the `(` after it (tokens of a run `match` found) make, and its code as an
 * entry lists it (`listed`): the call that parenthesis opens (`f(`, `this.#f(`, `(a ?? f)(`,
 * `new F(`), by its statement or the class member it is in (`t = f()`); or the function the name
 * declares (`declares`), by its signature, or by its statement for a function expression.
 * Undefined when it is neither: a guard fails on it.
 */
export function site(name: ts.Node, open: ts.Node): Site | undefined {
  const node = ts.isCallExpression(open.parent) || ts.isNewExpression(open.parent) ? open.parent : declares(name);
  return node && placed(node);
}

/**
 * A site: its node, what it is listed by (`at`, its statement or member) and that code's shape, and
 * the shape of its own expression (`call`: the call, or the string), which tells apart two sites
 * of one statement (`called` gives an entry's).
 */
export type Site = { node: ts.Node; at: ts.Node; code: string; call: string };
function placed(node: ts.Node): Site {
  const statement = statementOf(node);
  const at = signed(node) ? node : ts.findAncestor(node, (n) => n === statement || ts.isClassElement(n))!;
  const expression = ts.findAncestor(node, ts.isExpression);
  return { node, at, code: listing(at), call: expression ? shape(expression) : listing(at) };
}

const STRINGS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
]);
/**
 * Each match of a former line regex `re` in the text of `node`'s strings (or a template's parts, or a
 * regular expression), as written, as a site listed by its statement as `site` lists a call's: a
 * string may hold code that runs (a script given to `node -e`), which that regex read as any other line. Its `call` is the
 * line of the string it is on, as that regex read it, trimmed (an entry gives it as a string).
 */
export function stringSites(node: ts.Node, re: RegExp): Site[] {
  const every = new RegExp(re.source, `${re.flags.replace("g", "")}g`);
  return tokens(node).flatMap((t) => {
    if (!STRINGS.has(t.kind)) return [];
    // Its text between its delimiters: a quote or a backtick, `}` before a template's part, `${` after it, a regex's `/` and flags.
    const raw = t.getText();
    const text = raw.slice(1, t.kind === ts.SyntaxKind.RegularExpressionLiteral ? raw.lastIndexOf("/") : raw.endsWith("${") ? -2 : -1);
    return Array.from(text.matchAll(every), (m) => {
      const end = text.indexOf("\n", m.index);
      const line = text.slice(text.lastIndexOf("\n", m.index) + 1, end < 0 ? undefined : end).trim();
      return { ...placed(t), call: JSON.stringify(line) };
    });
  });
}

/** An expression's shape, as `Site.call` gives a site's: `code` is the call (or the string) alone. */
export function called(code: string): string {
  return shape((statement(`(${code});`) as ts.ExpressionStatement).expression);
}

/** The code an entry lists, as `site` gives a site's: a statement (`statement`), or a class member written in `class _ { … }`. */
export function listed(code: string): string {
  const parsed = statement(code);
  const wrapped = ts.isClassDeclaration(parsed) && parsed.name?.text === "_" && parsed.members.length === 1;
  return listing(wrapped ? parsed.members[0]! : parsed);
}
