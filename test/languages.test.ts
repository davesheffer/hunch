@@CLEANROOM_HOLE_1@@
import { readFileSync } from "node:fs";
@@CLEANROOM_HOLE_2@@
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies: Record<string, string>;
};

@@CLEANROOM_HOLE_3@@
test("CODE_EXTENSIONS matches the supported TS/JS/Python/Go/PHP/YAML extension list", () => {
@@CLEANROOM_HOLE_4@@
    [".cjs", ".cts", ".go", ".js", ".jsx", ".mjs", ".mts", ".php", ".py", ".pyi", ".tpl", ".ts", ".tsx", ".yaml", ".yml"].sort(),
@@CLEANROOM_HOLE_5@@
test("languageFor resolves .go to the go LanguageSpec", () => {
  const lang = languageFor("cmd/server/main.go");
  assert.ok(lang, "no LanguageSpec for .go");
  assert.equal(lang!.id, "go");
});

test("languageFor resolves .php to the PHP LanguageSpec", () => {
  assert.equal(languageFor("src/Worker.php")?.id, "php");
});

@@CLEANROOM_HOLE_6@@

@@CLEANROOM_HOLE_7@@
test("native grammar versions stay on the tree-sitter 0.21 peer family", () => {
  assert.equal(packageJson.dependencies["tree-sitter"], "0.21.1");
  assert.equal(packageJson.dependencies["tree-sitter-python"], "0.23.4",
    "0.23.5+ requires tree-sitter 0.22 and makes a clean npm install fail");
  assert.equal(packageJson.dependencies["@tree-sitter-grammars/tree-sitter-yaml"], "^0.6.1",
    "YAML 0.7+ requires tree-sitter 0.22 and must move only with the whole native parser matrix");
  assert.equal(packageJson.dependencies["tree-sitter-php"], "0.23.12",
    "PHP 0.24+ requires tree-sitter 0.22; 0.23.12 is the latest compatible 0.21 peer");
});
