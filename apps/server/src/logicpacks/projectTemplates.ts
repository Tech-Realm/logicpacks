/**
 * Starter files for "New project from a template". Small on purpose: enough
 * for an agent's first turn to have something to run, nothing to maintain.
 */
export interface ProjectTemplate {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly files: Readonly<Record<string, string>>;
}

export const PROJECT_TEMPLATES: ReadonlyArray<ProjectTemplate> = [
  {
    id: "website",
    title: "Website",
    description: "A static page with HTML and CSS.",
    files: {
      "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>New site</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main>
      <h1>Hello</h1>
      <p>Ask an agent to build this page out.</p>
    </main>
  </body>
</html>
`,
      "styles.css": `body {
  margin: 0;
  font-family: system-ui, sans-serif;
}

main {
  max-width: 40rem;
  margin: 4rem auto;
  padding: 0 1rem;
}
`,
    },
  },
  {
    id: "node-api",
    title: "Node API",
    description: "A small HTTP server with no dependencies.",
    files: {
      "package.json": `{
  "name": "api",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server.js"
  }
}
`,
      "server.js": `import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3000);

createServer((request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, path: request.url }));
}).listen(port, () => {
  console.log(\`Listening on http://localhost:\${port}\`);
});
`,
    },
  },
  {
    id: "python-script",
    title: "Python script",
    description: "A command line script with a main function.",
    files: {
      "main.py": `def main() -> None:
    print("Hello from Python")


if __name__ == "__main__":
    main()
`,
    },
  },
];

export const findProjectTemplate = (id: string) =>
  PROJECT_TEMPLATES.find((template) => template.id === id) ?? null;
