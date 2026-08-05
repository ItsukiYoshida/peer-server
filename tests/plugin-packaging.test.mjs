import assert from "node:assert/strict";
import {
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function readJson(relativePath) {
  return JSON.parse(
    await readFile(path.join(repositoryRoot, relativePath), "utf8"),
  );
}

test("marketplace entries reference valid plugin packages", async () => {
  const marketplace = await readJson(".agents/plugins/marketplace.json");

  assert.equal(marketplace.name, "peer-server");
  assert.deepEqual(
    marketplace.plugins.map(({ name }) => name).sort(),
    ["claude-peer", "codex-peer"],
  );

  for (const entry of marketplace.plugins) {
    assert.equal(entry.source.source, "local");
    assert.equal(entry.source.path, `./plugins/${entry.name}`);
    assert.equal(entry.policy.installation, "AVAILABLE");
    assert.equal(entry.policy.authentication, "ON_INSTALL");

    const pluginRoot = entry.source.path.slice(2);
    const manifest = await readJson(
      path.join(pluginRoot, ".codex-plugin/plugin.json"),
    );
    const mcpConfig = await readJson(path.join(pluginRoot, ".mcp.json"));

    assert.equal(manifest.name, entry.name);
    assert.match(manifest.version, /^\d+\.\d+\.\d+\+codex\.\d+$/);
    assert.ok(manifest.description);
    assert.ok(manifest.author?.name);
    assert.equal(manifest.skills, "./skills/");
    assert.equal(manifest.mcpServers, "./.mcp.json");
    assert.ok(manifest.interface?.displayName);
    assert.ok(manifest.interface?.shortDescription);

    const servers = Object.values(mcpConfig.mcpServers ?? {});
    assert.ok(servers.length > 0);

    for (const server of servers) {
      assert.equal(server.command, "node");
      assert.equal(server.cwd, ".");
      assert.ok(Array.isArray(server.args));
      assert.ok(server.args.every((argument) => typeof argument === "string"));

      const entrypointArguments = server.args.filter((argument) =>
        argument.endsWith(".mjs"),
      );
      assert.equal(
        entrypointArguments.length,
        1,
        `${entry.name} requires exactly one JavaScript entrypoint`,
      );

      const pluginPackageRoot = path.join(repositoryRoot, pluginRoot);
      const realPluginPackageRoot = await realpath(pluginPackageRoot);
      const entrypoint = path.resolve(
        pluginPackageRoot,
        entrypointArguments[0],
      );
      const realEntrypoint = await realpath(entrypoint);
      const relativeEntrypoint = path.relative(
        realPluginPackageRoot,
        realEntrypoint,
      );
      assert.ok(
        relativeEntrypoint &&
          !relativeEntrypoint.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relativeEntrypoint),
        `${entry.name} entrypoint must stay inside its plugin package`,
      );
      const entrypointStat = await stat(realEntrypoint);
      assert.ok(
        entrypointStat.isFile(),
        `${entry.name} entrypoint must be a regular file`,
      );
      if (entrypointArguments[0].endsWith(".mjs")) {
        await readFile(realEntrypoint);
      }
    }

    const skillRoot = path.join(repositoryRoot, pluginRoot, "skills");
    const skillDirectories = (await readdir(skillRoot, { withFileTypes: true }))
      .filter((directory) => directory.isDirectory());
    assert.ok(skillDirectories.length > 0);

    for (const directory of skillDirectories) {
      const skill = await readFile(
        path.join(skillRoot, directory.name, "SKILL.md"),
        "utf8",
      );
      const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      assert.ok(frontmatter, `${directory.name} requires YAML frontmatter`);
      assert.match(
        frontmatter[1],
        new RegExp(`^name:\\s*${directory.name}$`, "m"),
      );
      assert.match(frontmatter[1], /^description:\s*.+$/m);
    }
  }
});
