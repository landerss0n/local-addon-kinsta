import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Packaging guard for the renderer bundle.
 *
 * The renderer bundle is loaded by Local via a plain Node `require()` of
 * `lib/renderer/index.js` from inside the installed add-on directory
 * (`.../Local/addons/local-addon-kinsta/`), OUTSIDE Local's own app.asar.
 * So every bare `require("<pkg>")` left in the bundle (a webpack `external`)
 * MUST be resolvable from that directory on a CLEAN install — i.e. it must be
 * either:
 *   - a module Local's RendererAddonLoader provides on the context AND that is
 *     also resolvable as a real package from Local's runtime (react, react-dom,
 *     electron, @getflywheel/local*), or
 *   - one of our own `bundledDependencies` (shipped inside the .tgz node_modules).
 *
 * Anything else (e.g. a devDependency-only `react-router-dom`) is absent from
 * the released .tgz and throws MODULE_NOT_FOUND at load time — Local swallows
 * the throw, the add-on never registers its hooks, and no UI appears.
 *
 * Regression: 1.1.6 shipped `require("react-router-dom")` (devDependency only),
 * which crashed every clean install. Use context.ReactRouter instead.
 */
describe('renderer bundle packaging', () => {
  const bundlePath = path.resolve(__dirname, '../../lib/renderer/index.js');

  it('only requires runtime-resolvable modules (no devDependency-only externals)', () => {
    if (!fs.existsSync(bundlePath)) {
      throw new Error(
        `Built bundle not found at ${bundlePath}. Run "npm run build:renderer" first.`,
      );
    }

    const bundle = fs.readFileSync(bundlePath, 'utf8');
    const required = new Set<string>();
    const re = /require\(["']([^"']+)["']\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(bundle)) !== null) {
      const id = m[1];
      // Ignore relative requires (none expected in a bundled output anyway).
      if (!id.startsWith('.')) required.add(id);
    }

    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
    const bundled: string[] = pkg.bundledDependencies ?? [];

    // Modules guaranteed present at runtime on a clean install:
    //  - provided by Local's renderer host (and resolvable as real packages)
    //  - electron (always available in the renderer)
    //  - our own bundled dependencies (shipped inside the .tgz)
    const allowed = new Set<string>([
      'react',
      'react-dom',
      'electron',
      '@getflywheel/local',
      '@getflywheel/local-components',
      ...bundled,
    ]);

    const disallowed = [...required].filter((id) => {
      // allow subpath imports of an allowed package (e.g. "@getflywheel/local/renderer")
      const base = id.startsWith('@') ? id.split('/').slice(0, 2).join('/') : id.split('/')[0];
      return !allowed.has(id) && !allowed.has(base);
    });

    expect(disallowed).toEqual([]);
  });
});
