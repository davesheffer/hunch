import { test } from "node:test";
import assert from "node:assert/strict";
import { extractHelmDirectives } from "../src/extractors/helm.js";

test("single define spans from {{ to end action", () => {
  const src = '{{- define "mychart.labels" -}}\napp: {{ .Chart.Name }}\n{{- end -}}\n';
  const r = extractHelmDirectives(src);
  assert.equal(r.calls.length, 0);
  assert.equal(r.symbols.length, 1);
  const s = r.symbols[0]!;
  const expected = '{{- define "mychart.labels" -}}\napp: {{ .Chart.Name }}\n{{- end -}}';
  assert.equal(s.name, "mychart.labels");
  assert.equal(s.kind, "variable");
  assert.equal(s.startChar, 0);
  assert.equal(src.slice(s.startChar, s.endChar), expected);
  assert.equal(s.loc, 3);
  assert.equal(s.bodyText, expected);
});

test("include and template calls", () => {
  const r = extractHelmDirectives('{{ include "mychart.labels" . | nindent 4 }}\n{{ template "mychart.name" . }}\n');
  assert.deepEqual(r.calls.map((c) => c.callee).sort(), ["mychart.labels", "mychart.name"]);
  assert.ok(r.calls.every((c) => c.member === false));
  assert.equal(r.symbols.length, 0);
});

test("nested if inside define", () => {
  const src = [
    '{{- define "mychart.fullname" -}}',
    "{{- if .Values.fullnameOverride -}}",
    "{{ .Values.fullnameOverride }}",
    "{{- else -}}",
    "{{ .Release.Name }}",
    "{{- end -}}",
    "{{- end -}}",
  ].join("\n") + "\n";
  const r = extractHelmDirectives(src);
  assert.equal(r.symbols.length, 1);
  assert.equal(r.symbols[0]!.name, "mychart.fullname");
  assert.equal(r.symbols[0]!.endChar, src.lastIndexOf("{{- end -}}") + 11);
});

test("composition: define includes another", () => {
  const src = [
    '{{- define "mychart.labels" -}}',
    'app: {{ include "mychart.name" . }}',
    "{{- end -}}",
    '{{- define "mychart.name" -}}',
    "mychart",
    "{{- end -}}",
  ].join("\n") + "\n";
  const r = extractHelmDirectives(src);
  assert.deepEqual(r.symbols.map((s) => s.name), ["mychart.labels", "mychart.name"]);
  assert.equal(r.calls.length, 1);
  const c = r.calls[0]!;
  assert.equal(c.callee, "mychart.name");
  assert.ok(r.symbols[0]!.startChar <= c.atChar && c.atChar < r.symbols[0]!.endChar);
  assert.equal(src[c.atChar], "i");
  assert.equal(src.slice(c.atChar, c.atChar + 7), "include");
});

test("include in an assignment has exact offsets", () => {
  const src = '{{- $labels := include "mychart.labels" . -}}\n';
  const r = extractHelmDirectives(src);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]!.callee, "mychart.labels");
  assert.equal(r.calls[0]!.atChar, 15);
  assert.equal(r.calls[0]!.endChar, 39);
});

test("comment phantom call is reported", () => {
  const r = extractHelmDirectives('{{/* example: include "mychart.labels" . */}}\n');
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]!.callee, "mychart.labels");
});

test("plain YAML yields nothing", () => {
  const r = extractHelmDirectives("apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ .Release.Name }}\n");
  assert.deepEqual(r, { symbols: [], calls: [] });
});

test("unnamed define frames emit nothing", () => {
  assert.equal(extractHelmDirectives("{{ define }}x{{ end }}").symbols.length, 0);
  assert.equal(extractHelmDirectives("{{ define foo }}x{{ end }}").symbols.length, 0);
  assert.equal(extractHelmDirectives('{{ define "" }}x{{ end }}').symbols.length, 0);
});

test("stray end, unclosed define, empty and unterminated actions", () => {
  assert.deepEqual(extractHelmDirectives("{{ end }}"), { symbols: [], calls: [] });
  assert.equal(extractHelmDirectives('{{- define "x" -}}\nbody').symbols.length, 0);
  assert.deepEqual(extractHelmDirectives("{{}} {{ unterminated"), { symbols: [], calls: [] });
  assert.deepEqual(extractHelmDirectives(""), { symbols: [], calls: [] });
});

test("two calls on one line", () => {
  const src = '{{ include "a" . }}{{ template "b" . }}';
  const r = extractHelmDirectives(src);
  assert.deepEqual(r.calls.map((c) => c.callee), ["a", "b"]);
  assert.equal(r.calls[0]!.atChar, 3);
  assert.equal(r.calls[0]!.endChar, 14);
  assert.equal(r.calls[1]!.atChar, src.indexOf("template"));
  assert.equal(src.slice(r.calls[1]!.atChar, r.calls[1]!.endChar), 'template "b"');
});

test("non-calls: empty name, word boundaries, missing whitespace", () => {
  assert.equal(extractHelmDirectives('{{ include "" . }}').calls.length, 0);
  assert.equal(extractHelmDirectives('{{ xinclude "a" }}').calls.length, 0);
  assert.equal(extractHelmDirectives('{{ includes "a" }}').calls.length, 0);
  assert.equal(extractHelmDirectives('{{ include"a" }}').calls.length, 0);
  assert.equal(extractHelmDirectives('{{ (include "a" .) }}').calls.length, 1);
  assert.equal(extractHelmDirectives('{{ define "a" }}{{ end }}').calls.length, 0);
});

test("block yields no symbol and no call", () => {
  const r = extractHelmDirectives('{{ block "x" . }}hi{{ end }}');
  assert.deepEqual(r, { symbols: [], calls: [] });
});

test("nested defines emit inner first; duplicates kept", () => {
  const r = extractHelmDirectives('{{ define "o" }}{{ define "i" }}{{ end }}{{ end }}{{ define "o" }}{{ end }}');
  assert.deepEqual(r.symbols.map((s) => s.name), ["i", "o", "o"]);
});

test("long define truncates bodyText only", () => {
  const src = '{{ define "big" }}' + "x\n".repeat(3000) + "{{ end }}";
  const s = extractHelmDirectives(src).symbols[0]!;
  assert.equal(s.bodyText.length, 4000);
  assert.equal(s.bodyText, src.slice(0, 4000));
  assert.equal(s.endChar, src.length);
  assert.equal(s.loc, 3001);
});
