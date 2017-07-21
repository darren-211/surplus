import * as AST from './AST';
import { Params } from './preprocess';

// pre-compiled regular expressions
const rx = {
    identifier       : /^[a-zA-Z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*/,
    stringEscapedEnd : /[^\\](\\\\)*\\$/, // ending in odd number of escape slashes = next char of string escaped
    leadingWs        : /^\s+/,
    codeTerminator   : /^[\s<>/,;)\]}]/,
    codeContinuation : /^[^\s<>/,;)\]}]+/
};

const parens : { [p : string] : string } = {
    "("   : ")",
    "["   : "]",
    "{"   : "}",
    "{...": "}"
};

export type LOC = { line: number, col: number, pos: number };

export function parse(TOKS : string[], opts : Params) {
    var i = 0,
        EOF = TOKS.length === 0,
        TOK = EOF ? '' : TOKS[i],
        LINE = 0,
        COL = 0,
        POS = 0;

    return codeTopLevel();

    function codeTopLevel() {
        var segments = [],
            text = "",
            loc = LOC();

        while (!EOF) {
            if (IS('<')) {
                if (text) segments.push(new AST.CodeText(text, loc));
                text = "";
                segments.push(htmlElement());
                loc = LOC();
            } else if (IS('"') || IS("'")) {
                text += quotedString();
            } else if (IS('//')) {
                text += codeSingleLineComment();
            } else if (IS('/*')) {
                text += codeMultiLineComment();
            } else {
                text += TOK, NEXT();
            }
        }

        if (text) segments.push(new AST.CodeText(text, loc));

        return new AST.CodeTopLevel(segments);
    }

    function htmlElement() : AST.HtmlElement {
        if (NOT('<')) ERR("not at start of html element");

        var start = LOC(),
            tag = "",
            properties = [],
            content = [],
            hasContent = true;

        NEXT(); // pass '<'

        tag = SPLIT(rx.identifier);

        if (!tag) ERR("bad element name", start);

        SKIPWS();

        // scan for properties until end of opening tag
        while (!EOF && NOT('>') && NOT('/>')) {
            if (MATCH(rx.identifier)) {
                properties.push(property());
            } else if (!opts.jsx && IS('@')) {
                properties.push(mixin());
            } else if (opts.jsx && IS('{...')) {
                properties.push(jsxMixin());
            } else {
                ERR("unrecognized content in begin tag");
            }

            SKIPWS();
        }

        if (EOF) ERR("unterminated start node", start);

        hasContent = IS('>');

        NEXT(); // pass '>' or '/>'

        if (hasContent) {
            while (!EOF && NOT('</')) {
                if (IS('<')) {
                    content.push(htmlElement());
                } else if (!opts.jsx && IS('@')) {
                    content.push(htmlInsert());
                } else if (opts.jsx && IS('{')) {
                    content.push(jsxHtmlInsert());
                } else if (IS('<!--')) {
                    content.push(htmlComment());
                } else {
                    content.push(htmlText());
                }
            }

            if (EOF) ERR("element missing close tag", start);

            NEXT(); // pass '</'

            if (tag !== SPLIT(rx.identifier)) ERR("mismatched open and close tags", start);

            if (NOT('>')) ERR("malformed close tag");

            NEXT(); // pass '>'
        }

        return new AST.HtmlElement(tag, properties, content, start);
    }

    function htmlText() {
        var text = "";

        while (!EOF && NOT('<') && NOT('<!--') && (opts.jsx ? NOT('{') : NOT('@')) && NOT('</')) {
            text += TOK, NEXT();
        }

        return new AST.HtmlText(text);
    }

    function htmlComment() {
        if (NOT('<!--')) ERR("not in HTML comment");

        var start = LOC(),
            text = "";

        NEXT(); // skip '<!--'

        while (!EOF && NOT('-->')) {
            text += TOK, NEXT();
        }

        if (EOF) ERR("unterminated html comment", start);

        NEXT(); // skip '-->'

        return new AST.HtmlComment(text);
    }

    function htmlInsert() {
        if (NOT('@')) ERR("not at start of code insert");

        var loc = LOC();

        NEXT(); // pass '@'

        return new AST.HtmlInsert(embeddedCode(), loc);
    }

    function jsxHtmlInsert() {
        var loc = LOC();
        return new AST.HtmlInsert(jsxEmbeddedCode(), loc);
    }

    function property() {
        if (!MATCH(rx.identifier)) ERR("not at start of property declaration");

        var loc = LOC(),
            name = SPLIT(rx.identifier);

        SKIPWS(); // pass name

        if (IS('=')) {
            NEXT(); // pass '='

            SKIPWS();

            if (IS('"') || IS("'")) {
                return new AST.StaticProperty(name, quotedString());
            } else if (opts.jsx && IS('{')) {
                return new AST.DynamicProperty(name, jsxEmbeddedCode(), loc);
            } else if (!opts.jsx) {
                return new AST.DynamicProperty(name, embeddedCode(), loc);
            } else {
                return ERR("unexepected value for JSX property");
            }
        } else {
            return new AST.StaticProperty(name, "true");
        }
    }

    function mixin() {
        if (NOT('@')) ERR("not at start of mixin");

        var loc = LOC();

        NEXT(); // pass '@'

        return new AST.Mixin(embeddedCode(), loc);
    }

    function jsxMixin() {
        if (NOT('{...')) ERR("not at start of JSX mixin");

        var loc = LOC();

        return new AST.Mixin(jsxEmbeddedCode(), loc);
    }

    function embeddedCode() {
        var start = LOC(),
            segments = [] as (AST.CodeText | AST.HtmlElement)[],
            text = "",
            loc = LOC();

        // consume source text up to the first top-level terminating character
        while(!EOF && !MATCH(rx.codeTerminator)) {
            if (PARENS()) {
                text = balancedParens(segments, text, loc);
            } else if (IS("'") || IS('"')) {
                text += quotedString();
            } else {
                text += SPLIT(rx.codeContinuation);
            }
        }

        if (text) segments.push(new AST.CodeText(text, loc));

        if (segments.length === 0) ERR("not in embedded code", start);

        return new AST.EmbeddedCode(segments);
    }

    function jsxEmbeddedCode() {
        if (NOT('{') && NOT('{...')) ERR("not at start of JSX embedded code");

        var prefixLength = TOK.length,
            segments = [] as (AST.CodeText | AST.HtmlElement)[],
            loc = LOC(),
            last = balancedParens(segments, "", loc);
        
        // remove closing '}'
        last = last.substr(0, last.length - 1);
        segments.push(new AST.CodeText(last, loc));

        // remove opening '{' or '{...', adjusting code loc accordingly
        var first = segments[0] as AST.CodeText;
        first.loc.col += prefixLength;
        segments[0] = new AST.CodeText(first.text.substr(prefixLength), first.loc);

        return new AST.EmbeddedCode(segments);
    }

    function balancedParens(segments : (AST.CodeText | AST.HtmlElement)[], text : string, loc : LOC) {
        var start = LOC(),
            end = PARENS();

        if (end === undefined) ERR("not in parentheses");

        text += TOK, NEXT();

        while (!EOF && NOT(end)) {
            if (IS("'") || IS('"')) {
                text += quotedString();
            } else if (IS('//')) {
                text += codeSingleLineComment();
            } else if (IS('/*')) {
                text += codeMultiLineComment();
            } else if (IS("<")) {
                if (text) segments.push(new AST.CodeText(text, { line: loc.line, col: loc.col, pos: loc.pos }));
                text = "";
                segments.push(htmlElement());
                loc.line = LINE;
                loc.col = COL;
                loc.pos = POS;
            } else if (PARENS()) {
                text = balancedParens(segments, text, loc);
            } else {
                text += TOK, NEXT();
            }
        }

        if (EOF) ERR("unterminated parentheses", start);

        text += TOK, NEXT();

        return text;
    }

    function quotedString() {
        if (NOT("'") && NOT('"')) ERR("not in quoted string");

        var start = LOC(),
            quote,
            text;

        quote = text = TOK, NEXT();

        while (!EOF && (NOT(quote) || rx.stringEscapedEnd.test(text))) {
            text += TOK, NEXT();
        }

        if (EOF) ERR("unterminated string", start);

        text += TOK, NEXT();

        return text;
    }

    function codeSingleLineComment() {
        if (NOT("//")) ERR("not in code comment");

        var text = "";

        while (!EOF && NOT('\n')) {
            text += TOK, NEXT();
        }

        // EOF within a code comment is ok, just means that the text ended with a comment
        if (!EOF) text += TOK, NEXT();

        return text;
    }

    function codeMultiLineComment() {
        if (NOT("/*")) ERR("not in code comment");

        var start = LOC(),
            text = "";

        while (!EOF && NOT('*/')) {
            text += TOK, NEXT();
        }

        if (EOF) ERR("unterminated multi-line comment", start);

        text += TOK, NEXT();

        return text;
    }

    // token stream ops
    function NEXT() {
        if (TOK === "\n") LINE++, COL = 0, POS++;
        else if (TOK) COL += TOK.length, POS += TOK.length;

        if (++i >= TOKS.length) EOF = true, TOK = "";
        else TOK = TOKS[i];
    }

    function ERR(msg : string, loc? : { line : number, col : number, pos : number }) : never {
        loc = loc || LOC();
        var frag = " at line " + loc.line + " col " + loc.col + ": ``" + TOKS.join('').substr(loc.pos, 30).replace("\n", "").replace("\r", "") + "''";
        throw new Error(msg + frag);
    }

    function IS(t : string) {
        return TOK === t;
    }

    function NOT(t : string) {
        return TOK !== t;
    }

    function MATCH(rx : RegExp) {
        return rx.test(TOK);
    }

    function MATCHES(rx : RegExp) {
        return rx.exec(TOK);
    }

    function PARENS() {
        return parens[TOK];
    }

    function SKIPWS() {
        while (true) {
            if (IS('\n')) NEXT();
            else if (MATCHES(rx.leadingWs)) SPLIT(rx.leadingWs);
            else break;
        }
    }

    function SPLIT(rx : RegExp) {
        var ms = MATCHES(rx),
            m : string;
        if (ms && (m = ms[0])) {
            COL += m.length;
            POS += m.length;
            TOK = TOK.substring(m.length);
            if (TOK === "") NEXT();
            return m;
        } else {
            return "";
        }
    }

    function LOC() {
        return { line: LINE, col: COL, pos: POS };
    }
};
