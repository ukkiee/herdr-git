// The language name the Files preview hands the editor for a file, chosen from the file's
// name. Pure: no herdr import.
//
// The editor colors with syntect's default syntaxes and finds one by file extension: a name
// that is none of their extensions gets plain text. That set lacks many common languages
// (TypeScript, TOML, HCL, Kotlin, Swift, Dockerfile and more), so those borrow the closest
// syntax the editor has: it colors comments, strings and numbers right, and keywords only
// where the two languages share them. Formats with no close syntax (Vim script, Nix, Pug,
// Stylus, yarn.lock) stay plain: a borrowed one would paint most of the text wrong.

// editorLanguage(name) → a file extension the editor knows when this file has (or borrows)
// a syntax, else the file's own extension ("txt" without one), which shows as plain text.
// `name` may be a path; only its last part counts.
export function editorLanguage(name) {
  const base = String(name ?? "").split("/").pop();
  const lower = base.toLowerCase();
  if (NAMES[lower]) return NAMES[lower];
  for (const [pattern, language] of PATTERNS) if (pattern.test(lower)) return language;
  const ext = base.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "txt";
  return EXT[ext] ?? ext;
}

// Whole names, lower-cased.
const NAMES = byLanguage({
  make: ["makefile", "gnumakefile", "bsdmakefile", "justfile", ".justfile"],
  sh: [
    "dockerfile", "containerfile", ".envrc", ".flaskenv", ".gitattributes", "procfile", "cmakelists.txt",
    ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".bash_aliases", ".profile",
    ".zshrc", ".zprofile", ".zshenv", ".zlogin", ".zlogout", ".kshrc", ".cshrc", ".tcshrc",
  ],
  rb: [
    "gemfile", "rakefile", "podfile", "vagrantfile", "brewfile", "fastfile", "dangerfile", "appfile", "matchfile",
    "pluginfile", "gymfile", "snapfile", "scanfile", "guardfile", "berksfile", "capfile", "thorfile", ".irbrc", ".pryrc",
  ],
  py: ["build", "workspace", "tiltfile", "sconstruct", "sconscript", "snakefile"],
  groovy: ["jenkinsfile"],
  go: ["go.mod", "go.work"],
  properties: [".gitconfig", ".gitmodules", ".editorconfig", ".npmrc", ".flake8", ".pylintrc", ".coveragerc", ".pypirc"],
  json: [".babelrc", ".swcrc", ".jshintrc", ".firebaserc", ".watchmanconfig", "composer.lock", "flake.lock", "deno.lock"],
  // Either JSON or YAML inside: the YAML syntax reads both.
  yaml: [".eslintrc", ".prettierrc", ".stylelintrc", ".clang-format", ".clang-tidy", ".yamllint", "pipfile", "cargo.lock", "poetry.lock", "uv.lock"],
  r: [".rprofile"],
  lisp: [".emacs", ".spacemacs"],
});

// Names that come in many spellings.
const PATTERNS = [
  [/^\.env(\..+)?$/, "sh"], // .env, .env.local, .env.production
  [/^\.[\w.-]*ignore$/, "sh"], // .gitignore, .dockerignore, …
  [/^(dockerfile|containerfile)[.-]/, "sh"], // Dockerfile.dev, Dockerfile-prod
  [/^(requirements|constraints)([.-].*)?\.txt$/, "sh"],
  [/^makefile\./, "make"], // Makefile.am, Makefile.in
  [/^jenkinsfile[.-]/, "groovy"],
  [/^(build|workspace|module)\.bazel$/, "py"],
];

// Extensions (the part after the last dot), lower-cased, that borrow another syntax.
const EXT = byLanguage({
  js: ["ts", "tsx", "mts", "cts", "jsx", "mjs", "cjs", "es6", "sol", "prisma"],
  json: ["jsonc", "json5", "jsonl", "ndjson", "geojson", "webmanifest", "har", "ipynb", "code-workspace", "tsbuildinfo", "avsc"],
  yaml: ["toml", "cff"],
  html: ["vue", "svelte", "astro", "hbs", "handlebars", "mustache", "njk", "nunjucks", "twig", "liquid", "ejs", "jinja", "jinja2", "j2", "gohtml", "gotmpl", "cshtml", "razor"],
  css: ["scss", "less", "pcss", "postcss"],
  md: ["mdx", "rmd", "qmd", "mkd", "mkdn", "mdwn", "livemd"],
  xml: ["plist", "xib", "storyboard", "xaml", "axaml", "csproj", "fsproj", "vbproj", "vcxproj", "props", "targets", "resx", "nuspec", "iml", "xsl", "xlf", "xliff", "wsdl", "kml", "gpx", "entitlements", "ui", "qrc"],
  sh: ["env", "dockerfile", "containerfile", "ksh", "csh", "tcsh", "command", "bats", "conf", "ps1", "psm1", "psd1", "graphql", "graphqls", "gql", "cmake"],
  properties: ["ini", "cfg", "cnf", "editorconfig", "gitconfig", "desktop", "service", "socket", "timer"],
  // HCL (Terraform, Packer, Nomad): # comments, quoted strings, heredocs and numbers read the
  // same in the Ruby syntax.
  rb: ["tf", "tfvars", "hcl", "nomad", "ex", "exs", "cr", "jl", "coffee", "cson", "ru", "rbi", "rbs"],
  py: ["bzl", "bazel", "star", "ipy", "smk", "gd", "mojo"],
  scala: ["kt", "kts", "sc"],
  go: ["swift", "proto"],
  java: ["dart", "aidl", "pde"],
  rs: ["zig"],
  ml: ["fs", "fsi", "fsx"],
  hs: ["elm", "purs", "idr"],
  c: ["glsl", "vert", "frag", "geom", "tesc", "tese", "comp", "hlsl", "cginc"],
  cpp: ["cu", "cuh", "ino", "metal", "ixx", "cppm", "tcc"],
  clj: ["cljs", "cljc", "edn", "bb"],
  lisp: ["rkt", "fnl", "hy"],
  sql: ["psql", "pgsql", "mysql", "plsql", "hql", "cql", "tsql"],
  diff: ["rej", "diffs"],
  lua: ["luau", "rockspec"],
  erl: ["escript"],
  pl: ["perl", "psgi"],
});

function byLanguage(lists) {
  const map = {};
  for (const [language, names] of Object.entries(lists)) for (const n of names) map[n] = language;
  return map;
}
