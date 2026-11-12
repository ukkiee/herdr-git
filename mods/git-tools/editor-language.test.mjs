// node editor-language.test.mjs: which syntax the Files preview asks the editor for, by
// file name.
import assert from "node:assert/strict";
import { editorLanguage } from "./editor-language.js";

// Every file extension the editor (herdr-app 0.1.15) has a syntax for, read out of the app:
// its syntaxes are syntect's default set. A language name outside this list gets plain text.
const KNOWN = new Set([
  ".bash_aliases", ".bash_completions", ".bash_functions", ".bash_login", ".bash_logout",
  ".bash_profile", ".bash_variables", ".bashrc", ".profile", ".textmate_init", "adp", "appfile",
  "applescript", "appraisals", "as", "asa", "asp", "bash", "bat", "berksfile", "bib", "brewfile",
  "bsh", "build", "builder", "c", "c++", "capfile", "cc", "cgi", "cheffile", "cl", "clisp", "clj",
  "cls", "cmd", "config.ru", "cp", "cpp", "cpy", "cs", "css", "css.erb", "css.liquid", "csx", "cxx",
  "d", "ddl", "deliverfile", "di", "diff", "dml", "dot", "dpr", "dtml", "el", "emakefile", "erb",
  "erbsql", "erl", "fasl", "fastfile", "fcgi", "fish", "gemfile", "gemspec", "gnumakefile", "go",
  "gradle", "groovy", "guardfile", "gv", "gvy", "gyp", "gypi", "h", "h++", "haml", "hh", "hpp",
  "hrl", "hs", "htc", "htm", "html", "html.erb", "hxx", "inc", "inl", "ipp", "irbrc", "java",
  "jbuilder", "js", "js.erb", "json", "jsp", "l", "lhs", "lisp", "lsp", "ltx", "lua", "m", "mak",
  "make", "makefile", "markdn", "markdown", "matlab", "md", "mdown", "mk", "ml", "mli", "mll", "mly",
  "mm", "mud", "ocamlmakefile", "opml", "p", "pas", "patch", "php", "php3", "php4", "php5", "php7",
  "phps", "phpt", "phtml", "pl", "pm", "pod", "podspec", "prawn", "properties", "pxd", "pxd.in",
  "pxi", "pxi.in", "py", "py3", "pyi", "pyw", "pyx", "pyx.in", "r", "rabl", "rails", "rake",
  "rakefile", "rantfile", "rb", "rbx", "rd", "re", "rest", "rhtml", "rjs", "rprofile", "rpy", "rs",
  "rss", "rst", "ruby.rail", "rxml", "s", "sass", "sbt", "scala", "scanfile", "scm", "sconscript",
  "sconstruct", "script editor", "sh", "shtml", "simplecov", "snakefile", "snapfile", "sql",
  "sql.erb", "ss", "sty", "sublime-build", "sublime-color-scheme", "sublime-commands",
  "sublime-completions", "sublime-keymap", "sublime-macro", "sublime-menu", "sublime-mousemap",
  "sublime-project", "sublime-settings", "sublime-syntax", "sublime-theme", "svg", "t", "tcl", "tex",
  "textile", "thor", "thorfile", "tld", "tmpl", "tpl", "txt", "vagrantfile", "wscript", "xhtml",
  "xml", "xsd", "xslt", "yaml", "yaws", "yml", "zsh",
]);

// Environment files: shell assignments, in every spelling people give them.
for (const name of [".env", ".env.local", ".env.production", ".ENV", "prod.env", ".envrc", "config/.env.example"]) {
  assert.equal(editorLanguage(name), "sh", name);
}

// Files known by their whole name, in any case, also under a folder.
const BY_NAME = {
  "Makefile": "make", "makefile": "make", "GNUmakefile": "make", "Makefile.am": "make", "justfile": "make", ".justfile": "make",
  "Dockerfile": "sh", "dockerfile": "sh", "Dockerfile.dev": "sh", "Dockerfile-prod": "sh", "api.dockerfile": "sh", "Containerfile": "sh",
  ".gitignore": "sh", ".dockerignore": "sh", ".npmignore": "sh", ".prettierignore": "sh", ".helmignore": "sh", ".gitattributes": "sh",
  ".bashrc": "sh", ".bash_profile": "sh", ".zshrc": "sh", ".zprofile": "sh", ".zshenv": "sh", ".profile": "sh",
  "CMakeLists.txt": "sh", "requirements.txt": "sh", "requirements-dev.txt": "sh", "Procfile": "sh",
  "Gemfile": "rb", "Rakefile": "rb", "Podfile": "rb", "Vagrantfile": "rb", "Brewfile": "rb", "Fastfile": "rb", "Dangerfile": "rb", ".irbrc": "rb", ".pryrc": "rb",
  "BUILD": "py", "BUILD.bazel": "py", "WORKSPACE": "py", "MODULE.bazel": "py", "Tiltfile": "py", "SConstruct": "py", "Snakefile": "py",
  "Jenkinsfile": "groovy", "go.mod": "go", "go.work": "go",
  ".gitconfig": "properties", ".gitmodules": "properties", ".editorconfig": "properties", ".npmrc": "properties", ".flake8": "properties", ".pylintrc": "properties", ".coveragerc": "properties",
  ".babelrc": "json", ".swcrc": "json", ".jshintrc": "json", "composer.lock": "json", "flake.lock": "json",
  ".eslintrc": "yaml", ".prettierrc": "yaml", ".stylelintrc": "yaml", ".clang-format": "yaml", "Pipfile": "yaml", "Cargo.lock": "yaml", "poetry.lock": "yaml",
  ".Rprofile": "r", ".emacs": "lisp",
  "src/app/Makefile": "make", "deploy/Dockerfile": "sh",
};
for (const [name, language] of Object.entries(BY_NAME)) assert.equal(editorLanguage(name), language, name);

// Extensions the editor has no syntax for, borrowing the closest one.
const BORROWED = {
  "main.tf": "rb", "prod.tfvars": "rb", "config.hcl": "rb", "build.pkr.hcl": "rb", "job.nomad": "rb",
  "app.ex": "rb", "test.exs": "rb", "main.jl": "rb", "app.coffee": "rb", "server.cr": "rb", "config.ru": "rb", "types.rbi": "rb",
  "pyproject.toml": "yaml", "setup.cfg": "properties", "tox.ini": "properties", "app.service": "properties",
  "nginx.conf": "sh", "build.ps1": "sh", "schema.graphql": "sh", "q.gql": "sh", "tools.cmake": "sh", "test.bats": "sh", "run.ksh": "sh",
  "Main.kt": "scala", "build.gradle.kts": "scala", "script.sc": "scala",
  "App.swift": "go", "user.proto": "go",
  "main.dart": "java", "Service.aidl": "java",
  "main.zig": "rs",
  "Program.fs": "ml", "Lib.fsi": "ml", "script.fsx": "ml",
  "Main.elm": "hs", "Main.purs": "hs",
  "shader.glsl": "c", "light.frag": "c", "light.vert": "c", "fx.hlsl": "c",
  "kernel.cu": "cpp", "kernel.cuh": "cpp", "sketch.ino": "cpp", "math.metal": "cpp",
  "style.scss": "css", "style.less": "css", "style.pcss": "css",
  "Page.astro": "html", "card.hbs": "html", "card.handlebars": "html", "page.mustache": "html", "base.njk": "html",
  "page.twig": "html", "page.liquid": "html", "view.ejs": "html", "page.jinja": "html", "page.j2": "html", "View.cshtml": "html", "Comp.razor": "html",
  "post.mdx": "md", "report.Rmd": "md", "report.qmd": "md",
  "Info.plist": "xml", "Main.storyboard": "xml", "View.xib": "xml", "App.xaml": "xml", "App.csproj": "xml", "Dir.props": "xml", "Res.resx": "xml",
  "data.jsonl": "json", "data.ndjson": "json", "conf.json5": "json", "map.geojson": "json", "nb.ipynb": "json", "site.webmanifest": "json",
  "app.cjs": "js", "Token.sol": "js", "schema.prisma": "js",
  "core.cljs": "clj", "deps.edn": "clj", "main.rkt": "lisp",
  "query.psql": "sql", "query.hql": "sql",
  "fix.rej": "diff", "init.luau": "lua", "a.rockspec": "lua",
  "player.gd": "py", "rules.bzl": "py", "main.mojo": "py",
};
for (const [name, language] of Object.entries(BORROWED)) assert.equal(editorLanguage(name), language, name);

// Every name handed over for a borrowed or named file is one the editor knows.
for (const name of [".env", ...Object.keys(BY_NAME), ...Object.keys(BORROWED)]) {
  assert.ok(KNOWN.has(editorLanguage(name)), `${name} → ${editorLanguage(name)}`);
}

// Files the editor has a syntax for keep their own extension, in any case.
for (const name of ["a.py", "a.rs", "a.go", "a.java", "a.rb", "a.php", "a.c", "a.h", "a.cpp", "a.cs", "a.lua", "a.sql", "a.sh", "a.zsh", "a.fish", "a.yml", "a.yaml", "a.json", "a.xml", "a.svg", "a.md", "a.html", "a.css", "a.js", "a.scala", "a.groovy", "a.gradle", "a.properties", "a.diff", "a.tex", "a.gemspec", "a.R", "a.PY", "a.sass", "start.s"]) {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  assert.equal(editorLanguage(name), ext, name);
}

// Files with no close syntax stay plain: a name the editor doesn't know, or "txt".
for (const name of [".vimrc", "yarn.lock", "Gemfile.lock", "go.sum", "data.csv", "README", "LICENSE", "CODEOWNERS", "notes.org", "doc.adoc", "flake.nix", "a.vb", "a.f90", "a.asm", "a.styl", "a.pug", "a.http", ".nvmrc", "a.log"]) {
  const language = editorLanguage(name);
  assert.ok(language === "txt" || !KNOWN.has(language), `${name} → ${language}`);
}

// A path counts by its last part; no name at all is plain text.
assert.equal(editorLanguage("infra/modules/net/main.tf"), "rb");
assert.equal(editorLanguage("src/.env.local"), "sh");
assert.equal(editorLanguage(""), "txt");
assert.equal(editorLanguage(undefined), "txt");

console.log("editor-language: ok");
