import { test } from "node:test";
import assert from "node:assert/strict";
import { extractHelmDirectives } from "../src/extractors/helm.js";

test("a single define/end pair produces one variable symbol spanning the whole block", () => {
  const src = `{{- define "mychart.labels" -}}\napp: {{ .Chart.Name }}\n{{- end -}}\n`;
  const { symbols, calls } = extractHelmDirectives(src);
  assert.equal(calls.length, 0);
  assert.equal(symbols.length, 1);
  assert.equal(symbols[0]!.name, "mychart.labels");
  assert.equal(symbols[0]!.kind, "variable");
  assert.equal(src.slice(symbols[0]!.startChar, symbols[0]!.endChar), `{{- define "mychart.labels" -}}\napp: {{ .Chart.Name }}\n{{- end -}}`);
});

test("include and template call sites both produce a call for the quoted name", () => {
  const src = `{{ include "mychart.labels" . | nindent 4 }}\n{{ template "mychart.name" . }}\n`;
  const { calls } = extractHelmDirectives(src);
  assert.deepEqual(calls.map((c) => c.callee).sort(), ["mychart.labels", "mychart.name"]);
  assert.ok(calls.every((c) => c.member === false));
});

test("a define body containing its own if/end closes at the MATCHING end, not the inner one", () => {
  const src = [
    `{{- define "mychart.fullname" -}}`,
    `{{- if .Values.fullnameOverride -}}`,
    `{{ .Values.fullnameOverride }}`,
    `{{- else -}}`,
    `{{ .Release.Name }}`,
    `{{- end -}}`,
    `{{- end -}}`,
    ``,
  ].join("\n");
  const { symbols } = extractHelmDirectives(src);
  assert.equal(symbols.length, 1, "the inner if/end must not be mistaken for the define's own end");
  assert.equal(symbols[0]!.name, "mychart.fullname");
  // the symbol's range must reach the FINAL end (the define's own), not the inner if's end
  assert.equal(symbols[0]!.endChar, src.lastIndexOf(`{{- end -}}`) + `{{- end -}}`.length);
});

test("a call nested inside one define invoking another define name is attributed correctly (composition)", () => {
  const src = [
    `{{- define "mychart.labels" -}}`,
    `app: {{ include "mychart.name" . }}`,
    `{{- end -}}`,
    `{{- define "mychart.name" -}}`,
    `mychart`,
    `{{- end -}}`,
    ``,
  ].join("\n");
  const { symbols, calls } = extractHelmDirectives(src);
  assert.equal(symbols.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.callee, "mychart.name");
  const labelsSymbol = symbols.find((s) => s.name === "mychart.labels")!;
  assert.ok(
    calls[0]!.atChar >= labelsSymbol.startChar && calls[0]!.atChar < labelsSymbol.endChar,
    "the include call site must fall within the enclosing define's char range",
  );
});

test("an include inside a variable assignment ($x := include ...) is still detected", () => {
  const src = `{{- $labels := include "mychart.labels" . -}}\n`;
  const { calls } = extractHelmDirectives(src);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.callee, "mychart.labels");
});

test("a define/include-shaped string inside a {{/* comment */}} is a documented, accepted limitation — pinned, not silently ignored", () => {
  const src = `{{/* example: include "mychart.labels" . */}}\n`;
  const { calls } = extractHelmDirectives(src);
  // Current behavior: the token scan has no concept of comments, so this DOES
  // produce a phantom call — accepted per the design doc's documented limitation.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.callee, "mychart.labels");
});

test("plain YAML/output content with no define/include/template produces nothing", () => {
  const src = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ .Release.Name }}\n`;
  const { symbols, calls } = extractHelmDirectives(src);
  assert.equal(symbols.length, 0);
  assert.equal(calls.length, 0);
});
