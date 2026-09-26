/*
 * The formula language, parsed as the book parses it.
 *
 * The book parses a formula with Python's own parser (`ast.parse(text.strip(), mode="eval")`) and
 * then walks the tree against a whitelist (sizing/expr.py). Two different refusals come out of
 * that: text that is not Python at all (a syntax error), and Python the language does not allow
 * (a comparison, a call to `abs`, a string). The builder must give the same one, because it tells
 * the reader what to fix. So this parses Python's expression grammar far enough to build the same
 * tree, marks every node the whitelist refuses, and then walks it top down, left to right, exactly
 * as `_convert` does, so that the first refusal reached is the book's.
 *
 * Held to the book by the formula probes in conformance/fixtures/formulas.json.
 */

export const FUNCTIONS = ["ceil", "exp", "floor", "log", "max", "min", "sqrt"];

export class FormulaError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue",
  "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in",
  "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);

const syntax = (message) => new FormulaError("load.formula-syntax", message);

// -- tokens --------------------------------------------------------------------------------------

const DIGITS = "[0-9](?:_?[0-9])*";
const EXPONENT = `[eE][-+]?${DIGITS}`;
const POINT_FLOAT = `(?:${DIGITS})?\\.${DIGITS}(?:${EXPONENT})?|${DIGITS}\\.(?:${EXPONENT})?`;
const FLOAT = `(?:${POINT_FLOAT}|${DIGITS}${EXPONENT})`;
const NUMBER = new RegExp(
  `^(?:(?<imaginary>(?:${FLOAT}|${DIGITS})[jJ])|(?<float>${FLOAT})|(?<hex>0[xX](?:_?[0-9a-fA-F])+)|(?<bin>0[bB](?:_?[01])+)|(?<oct>0[oO](?:_?[0-7])+)|(?<decimal>[0-9](?:_?[0-9])*))`,
  "u",
);
const NAME = /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]*/u;
const STRING = /^([rRbBuUfF]{0,2})('''|"""|'|")/u;
const OPERATORS = [
  "**=", "//=", ">>=", "<<=", "...", "->", "**", "//", ">>", "<<", "<=", ">=", "==", "!=", ":=",
  "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "@=",
  "+", "-", "*", "/", "%", "@", "&", "|", "^", "~", "<", ">", "(", ")", "[", "]", "{", "}",
  ",", ":", ";", ".", "=",
];

function tokenize(text) {
  const tokens = [];
  const brackets = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const blank = /^[ \t\f]+/.exec(rest);
    if (blank) {
      i += blank[0].length;
      continue;
    }
    if (rest.startsWith("\\\n") || rest.startsWith("\\\r\n")) {
      i += rest.startsWith("\\\n") ? 2 : 3;
      continue;
    }
    if (rest[0] === "#") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (rest[0] === "\n" || rest[0] === "\r") {
      // Inside brackets a newline is whitespace; outside, it ends the expression.
      if (!brackets.length) tokens.push({ type: "NEWLINE", string: "\n" });
      i += rest.startsWith("\r\n") ? 2 : 1;
      continue;
    }
    const string = STRING.exec(rest);
    if (string && (string[1] === "" || /^(?:[rRuUbBfF]|[rR][bBfF]|[bBfF][rR])$/.test(string[1]))) {
      const quote = string[2];
      const raw = /[rR]/.test(string[1]);
      let j = string[0].length;
      let closed = false;
      while (j < rest.length) {
        if (!raw && rest[j] === "\\") {
          j += 2;
          continue;
        }
        if (raw && rest[j] === "\\") {
          j += 2;
          continue;
        }
        if (quote.length === 1 && rest[j] === "\n") break;
        if (rest.startsWith(quote, j)) {
          j += quote.length;
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) throw syntax("unterminated string literal");
      tokens.push({ type: "STRING", string: rest.slice(0, j), prefix: string[1].toLowerCase() });
      i += j;
      continue;
    }
    const number = NUMBER.exec(rest);
    if (number && !(rest[0] === "." && !/^\.[0-9]/.test(rest))) {
      const after = rest.slice(number[0].length);
      const digits = number[0].replaceAll("_", "");
      if (number.groups.decimal && digits.length > 1 && digits[0] === "0" && /[1-9]/.test(digits)) {
        throw syntax("leading zeros in decimal integer literals are not permitted");
      }
      if (/^[\p{L}\p{N}_]/u.test(after) && !/^(?:and|or|if|else|in|is|not|for)\b/.test(after)) {
        throw syntax("invalid decimal literal");
      }
      tokens.push({ type: "NUMBER", string: number[0], groups: number.groups });
      i += number[0].length;
      continue;
    }
    const name = NAME.exec(rest);
    if (name) {
      tokens.push({ type: "NAME", string: name[0] });
      i += name[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => rest.startsWith(o));
    if (op) {
      if ("([{".includes(op)) brackets.push(op);
      if (")]}".includes(op)) {
        const open = brackets.pop();
        if (!open || "([{".indexOf(open) !== ")]}".indexOf(op)) throw syntax(`unmatched '${op}'`);
      }
      tokens.push({ type: "OP", string: op });
      i += op.length;
      continue;
    }
    throw syntax(`invalid character '${rest[0]}'`);
  }
  if (brackets.length) throw syntax(`'${brackets.at(-1)}' was never closed`);
  tokens.push({ type: "END", string: "" });
  return tokens;
}

// -- a recursive-descent parser for Python's expression grammar ---------------------------------
//
// It builds a small tree of its own, closer to Python's ast than to the book's exported form:
// { kind: "constant", value, pytype }, { kind: "name", id }, { kind: "binop", op, left, right },
// { kind: "unary", op, operand }, { kind: "call", func, args, keywords }, and { kind: "construct",
// type } for anything the whitelist refuses whatever is inside it.

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.at = 0;
  }
  peek(offset = 0) {
    return this.tokens[this.at + offset];
  }
  isOp(op, offset = 0) {
    const t = this.peek(offset);
    return t.type === "OP" && t.string === op;
  }
  isWord(word, offset = 0) {
    const t = this.peek(offset);
    return t.type === "NAME" && t.string === word;
  }
  take() {
    return this.tokens[this.at++];
  }
  expectOp(op) {
    if (!this.isOp(op)) throw syntax(`expected '${op}'`);
    return this.take();
  }

  // eval_input: expressions NEWLINE* ENDMARKER
  parseInput() {
    const node = this.expressions();
    while (this.peek().type === "NEWLINE") this.take();
    if (this.peek().type !== "END") throw syntax("invalid syntax");
    return node;
  }

  // expressions: expression (',' expression)* [','] -- a tuple when there is a comma
  expressions() {
    const first = this.starOrExpression();
    if (!this.isOp(",")) {
      if (first.kind === "starred") throw syntax("can't use starred expression here");
      return first;
    }
    while (this.isOp(",")) {
      this.take();
      if (this.endsSequence()) break;
      this.starOrExpression();
    }
    return { kind: "construct", type: "Tuple" };
  }

  endsSequence() {
    const t = this.peek();
    return t.type === "END" || t.type === "NEWLINE" || (t.type === "OP" && [")", "]", "}", ":"].includes(t.string));
  }

  starOrExpression() {
    if (this.isOp("*")) {
      this.take();
      this.bitwiseOr();
      return { kind: "starred" };
    }
    return this.namedExpression();
  }

  namedExpression() {
    if (this.peek().type === "NAME" && !KEYWORDS.has(this.peek().string) && this.isOp(":=", 1)) {
      this.take();
      this.take();
      this.expression();
      return { kind: "construct", type: "NamedExpr" };
    }
    return this.expression();
  }

  // expression: lambda | disjunction ['if' disjunction 'else' expression]
  expression() {
    if (this.isWord("lambda")) {
      this.take();
      this.lambdaParameters();
      this.expectOp(":");
      this.expression();
      return { kind: "construct", type: "Lambda" };
    }
    const body = this.disjunction();
    if (this.isWord("if")) {
      this.take();
      this.disjunction();
      if (!this.isWord("else")) throw syntax("expected 'else' after 'if' expression");
      this.take();
      this.expression();
      return { kind: "construct", type: "IfExp" };
    }
    return body;
  }

  lambdaParameters() {
    while (!this.isOp(":")) {
      if (this.isOp("*") || this.isOp("**")) this.take();
      if (this.peek().type === "NAME" && !KEYWORDS.has(this.peek().string)) this.take();
      else if (!this.isOp(",")) throw syntax("invalid syntax");
      if (this.isOp("=")) {
        this.take();
        this.expression();
      }
      if (this.isOp(",")) this.take();
      else break;
    }
  }

  disjunction() {
    const first = this.conjunction();
    if (!this.isWord("or")) return first;
    while (this.isWord("or")) {
      this.take();
      this.conjunction();
    }
    return { kind: "construct", type: "BoolOp" };
  }

  conjunction() {
    const first = this.inversion();
    if (!this.isWord("and")) return first;
    while (this.isWord("and")) {
      this.take();
      this.inversion();
    }
    return { kind: "construct", type: "BoolOp" };
  }

  inversion() {
    if (this.isWord("not")) {
      this.take();
      this.inversion();
      return { kind: "construct", type: "UnaryOp" };
    }
    return this.comparison();
  }

  comparison() {
    const first = this.bitwiseOr();
    let compared = false;
    for (;;) {
      if (["==", "!=", "<", "<=", ">", ">="].some((op) => this.isOp(op))) this.take();
      else if (this.isWord("in")) this.take();
      else if (this.isWord("not") && this.isWord("in", 1)) {
        this.take();
        this.take();
      } else if (this.isWord("is")) {
        this.take();
        if (this.isWord("not")) this.take();
      } else break;
      this.bitwiseOr();
      compared = true;
    }
    return compared ? { kind: "construct", type: "Compare" } : first;
  }

  binaryLevel(ops, next) {
    let left = next();
    while (ops.some((op) => this.isOp(op))) {
      const op = this.take().string;
      const right = next();
      left = { kind: "binop", op, left, right };
    }
    return left;
  }

  bitwiseOr() {
    return this.binaryLevel(["|"], () => this.bitwiseXor());
  }
  bitwiseXor() {
    return this.binaryLevel(["^"], () => this.bitwiseAnd());
  }
  bitwiseAnd() {
    return this.binaryLevel(["&"], () => this.shift());
  }
  shift() {
    return this.binaryLevel(["<<", ">>"], () => this.sum());
  }
  sum() {
    return this.binaryLevel(["+", "-"], () => this.term());
  }
  term() {
    return this.binaryLevel(["*", "/", "//", "%", "@"], () => this.factor());
  }

  // factor: ('+' | '-' | '~') factor | power
  factor() {
    if (this.isOp("+") || this.isOp("-") || this.isOp("~")) {
      const op = this.take().string;
      return { kind: "unary", op, operand: this.factor() };
    }
    return this.power();
  }

  // power: await_primary ['**' factor]
  power() {
    let base;
    if (this.isWord("await")) {
      this.take();
      this.primary();
      base = { kind: "construct", type: "Await" };
    } else base = this.primary();
    if (this.isOp("**")) {
      this.take();
      return { kind: "binop", op: "**", left: base, right: this.factor() };
    }
    return base;
  }

  primary() {
    let node = this.atom();
    for (;;) {
      if (this.isOp(".")) {
        this.take();
        const name = this.take();
        if (name.type !== "NAME") throw syntax("invalid syntax");
        node = { kind: "construct", type: "Attribute" };
      } else if (this.isOp("(")) {
        this.take();
        node = this.callArguments(node);
      } else if (this.isOp("[")) {
        this.take();
        this.slices();
        this.expectOp("]");
        node = { kind: "construct", type: "Subscript" };
      } else return node;
    }
  }

  callArguments(func) {
    const args = [];
    const keywords = [];
    while (!this.isOp(")")) {
      if (this.isOp("**")) {
        this.take();
        this.expression();
        keywords.push(null);
      } else if (this.peek().type === "NAME" && !KEYWORDS.has(this.peek().string) && this.isOp("=", 1)) {
        this.take();
        this.take();
        this.expression();
        keywords.push(null);
      } else if (this.isOp("*")) {
        this.take();
        this.expression();
        args.push({ kind: "construct", type: "Starred" });
      } else {
        const argument = this.namedExpression();
        if (this.isWord("for") || this.isWord("async")) {
          this.comprehension();
          args.push({ kind: "construct", type: "GeneratorExp" });
        } else args.push(argument);
      }
      if (this.isOp(",")) this.take();
      else break;
    }
    this.expectOp(")");
    return { kind: "call", func, args, keywords };
  }

  slices() {
    do {
      if (this.isOp(",")) this.take();
      if (this.isOp("]")) return;
      if (!this.isOp(":")) this.namedExpression();
      while (this.isOp(":")) {
        this.take();
        if (!this.isOp(":") && !this.isOp(",") && !this.isOp("]")) this.expression();
      }
    } while (this.isOp(","));
  }

  comprehension() {
    while (this.isWord("for") || this.isWord("async")) {
      if (this.isWord("async")) this.take();
      if (!this.isWord("for")) throw syntax("invalid syntax");
      this.take();
      this.targetList();
      if (!this.isWord("in")) throw syntax("invalid syntax");
      this.take();
      this.disjunction();
      while (this.isWord("if")) {
        this.take();
        this.disjunction();
      }
    }
  }

  targetList() {
    do {
      if (this.isOp(",")) this.take();
      if (this.isOp("*")) this.take();
      this.primaryTarget();
    } while (this.isOp(","));
  }

  primaryTarget() {
    if (this.isOp("(") || this.isOp("[")) {
      const close = this.take().string === "(" ? ")" : "]";
      if (!this.isOp(close)) this.targetList();
      this.expectOp(close);
      return;
    }
    this.primary();
  }

  atom() {
    const t = this.peek();
    if (t.type === "NAME") {
      if (t.string === "True" || t.string === "False") {
        this.take();
        return { kind: "constant", pytype: "bool" };
      }
      if (t.string === "None") {
        this.take();
        return { kind: "constant", pytype: "NoneType" };
      }
      if (KEYWORDS.has(t.string)) {
        if (t.string === "yield") return this.yieldExpression();
        throw syntax("invalid syntax");
      }
      this.take();
      return { kind: "name", id: t.string.normalize("NFKC") };
    }
    if (t.type === "NUMBER") {
      this.take();
      return numberConstant(t);
    }
    if (t.type === "STRING") {
      let formatted = false;
      let bytes = false;
      let text = false;
      while (this.peek().type === "STRING") {
        const s = this.take();
        if (s.prefix.includes("f")) formatted = true;
        if (s.prefix.includes("b")) bytes = true;
        else text = true;
      }
      if (bytes && text) throw syntax("cannot mix bytes and nonbytes literals");
      if (formatted) return { kind: "construct", type: "JoinedStr" };
      return { kind: "constant", pytype: bytes ? "bytes" : "str" };
    }
    if (t.type === "OP") {
      if (t.string === "...") {
        this.take();
        return { kind: "constant", pytype: "ellipsis" };
      }
      if (t.string === "(") return this.parenthesised();
      if (t.string === "[") return this.bracketed("[", "]", "List", "ListComp");
      if (t.string === "{") return this.braced();
    }
    throw syntax("invalid syntax");
  }

  yieldExpression() {
    this.take();
    if (this.isWord("from")) {
      this.take();
      this.expression();
    } else if (!this.endsSequence()) this.expressions();
    return { kind: "construct", type: "Yield" };
  }

  parenthesised() {
    this.take();
    if (this.isOp(")")) {
      this.take();
      return { kind: "construct", type: "Tuple" };
    }
    if (this.isWord("yield")) {
      const node = this.yieldExpression();
      this.expectOp(")");
      return node;
    }
    const first = this.starOrExpression();
    if (this.isWord("for") || this.isWord("async")) {
      this.comprehension();
      this.expectOp(")");
      return { kind: "construct", type: "GeneratorExp" };
    }
    if (this.isOp(",")) {
      while (this.isOp(",")) {
        this.take();
        if (this.isOp(")")) break;
        this.starOrExpression();
      }
      this.expectOp(")");
      return { kind: "construct", type: "Tuple" };
    }
    if (first.kind === "starred") throw syntax("cannot use starred expression here");
    this.expectOp(")");
    return first;
  }

  bracketed(open, close, plain, comprehension) {
    this.take();
    if (this.isOp(close)) {
      this.take();
      return { kind: "construct", type: plain };
    }
    this.starOrExpression();
    if (this.isWord("for") || this.isWord("async")) {
      this.comprehension();
      this.expectOp(close);
      return { kind: "construct", type: comprehension };
    }
    while (this.isOp(",")) {
      this.take();
      if (this.isOp(close)) break;
      this.starOrExpression();
    }
    this.expectOp(close);
    return { kind: "construct", type: plain };
  }

  braced() {
    this.take();
    if (this.isOp("}")) {
      this.take();
      return { kind: "construct", type: "Dict" };
    }
    let dict = false;
    if (this.isOp("**")) {
      this.take();
      this.bitwiseOr();
      dict = true;
    } else {
      this.starOrExpression();
      if (this.isOp(":")) {
        this.take();
        this.expression();
        dict = true;
      }
    }
    if (this.isWord("for") || this.isWord("async")) {
      this.comprehension();
      this.expectOp("}");
      return { kind: "construct", type: dict ? "DictComp" : "SetComp" };
    }
    while (this.isOp(",")) {
      this.take();
      if (this.isOp("}")) break;
      if (dict) {
        if (this.isOp("**")) {
          this.take();
          this.bitwiseOr();
        } else {
          this.expression();
          this.expectOp(":");
          this.expression();
        }
      } else this.starOrExpression();
    }
    this.expectOp("}");
    return { kind: "construct", type: dict ? "Dict" : "Set" };
  }
}

function numberConstant(token) {
  const g = token.groups;
  const plain = token.string.replaceAll("_", "");
  if (g.imaginary) return { kind: "constant", pytype: "complex" };
  if (g.float) return { kind: "constant", pytype: "float", value: Number(plain) };
  let value;
  if (g.hex) value = Number(BigInt(plain.toLowerCase().replace("0x", "0x")));
  else if (g.bin) value = Number(BigInt(plain.toLowerCase()));
  else if (g.oct) value = Number(BigInt(plain.toLowerCase()));
  else value = Number(BigInt(plain));
  return { kind: "constant", pytype: "int", value };
}

// -- the book's whitelist: sizing/expr.py's _convert, in its order --------------------------------

const BINARY = { "+": "+", "-": "-", "*": "*", "/": "/", "**": "**" };

function convert(node, text, where) {
  switch (node.kind) {
    case "constant":
      if (node.pytype !== "int" && node.pytype !== "float") {
        throw new FormulaError("load.formula-constant", `${where}: that constant is not a number`);
      }
      if (!Number.isFinite(node.value) && node.pytype === "int") {
        // float() of an integer too large for a float: Python raises OverflowError here, which
        // the book does not word as a refusal.
        throw new FormulaError("load.malformed", `${where}: int too large to convert to float`);
      }
      return { op: "const", value: node.value };
    case "name":
      return { op: "ref", name: node.id };
    case "binop":
      if (node.op in BINARY) {
        return { op: BINARY[node.op], args: [convert(node.left, text, where), convert(node.right, text, where)] };
      }
      break;
    case "unary":
      if (node.op === "-") return { op: "neg", args: [convert(node.operand, text, where)] };
      if (node.op === "+") return convert(node.operand, text, where);
      break;
    case "call": {
      if (node.func.kind !== "name" || !FUNCTIONS.includes(node.func.id)) {
        const name = node.func.kind === "name" ? node.func.id : "that";
        throw new FormulaError(
          "load.formula-function",
          `${where}: '${text}' calls '${name}'. A formula may call only ${FUNCTIONS.join(", ")}.`,
        );
      }
      if (node.keywords.length) {
        throw new FormulaError("load.formula-keywords", `${where}: ${node.func.id}() takes positional arguments only`);
      }
      return { op: "call", fn: node.func.id, args: node.args.map((arg) => convert(arg, text, where)) };
    }
    default:
      break;
  }
  throw new FormulaError(
    "load.formula-construct",
    `${where}: '${text}' uses something this language does not have. Formulas are arithmetic over other nodes.`,
  );
}

/* A formula as the book's parser reads it: the exported tree, or a FormulaError with its code. */
export function parse(text, where = "formula") {
  const source = String(text).trim();
  let tree;
  try {
    tree = new Parser(tokenize(source)).parseInput();
  } catch (error) {
    if (error instanceof FormulaError) {
      throw new FormulaError(error.code, `${where}: '${source}' does not parse (${error.message})`);
    }
    throw error;
  }
  return convert(tree, source, where);
}

/* Every node name a formula depends on. */
export function refs(tree, into = new Set()) {
  if (tree.op === "ref") into.add(tree.name);
  for (const arg of tree.args ?? []) refs(arg, into);
  return into;
}

/* The tree back as readable arithmetic, as sizing/expr.py's render does. */
export function render(tree) {
  switch (tree.op) {
    case "const":
      return Number.isInteger(tree.value) ? String(tree.value) : String(tree.value);
    case "ref":
      return tree.name;
    case "neg":
      return `-${render(tree.args[0])}`;
    case "call":
      return `${tree.fn}(${tree.args.map(render).join(", ")})`;
    default:
      return `(${render(tree.args[0])} ${tree.op} ${render(tree.args[1])})`;
  }
}
