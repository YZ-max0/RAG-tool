
// Reproduce the Host's own dsh.client validation (dsh-client-modules
// normalizeClientDeclaration + clientExportOf) against the installed package,
// and resolve the bundle the way the /plugins route does.
//
// Usage: node tools/check-manifest.cjs <pkgDir> [profileDir]
//   pkgDir      the installed package directory (usually the profile's
//               node_modules/@local/dsh-ragflow-settings junction)
//   profileDir  the profile root Node should resolve from; defaults to pkgDir's
//               grandparent two levels up, which is right for a plain install.
const fs = require('fs');
const path = require('path');

const PKG_NAME = '@local/dsh-ragflow-settings';
const pkgDir = process.argv[2];
if (!pkgDir) {
  console.error('usage: node tools/check-manifest.cjs <pkgDir> [profileDir]');
  process.exit(2);
}
const profileDir = process.argv[3] || path.resolve(pkgDir, '..', '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));

function optionalStringArray(pkgName, field, value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('client-modules: ' + pkgName + ' ' + field + ' must be a string array');
  }
  return [...value];
}

function normalizeClientDeclaration(pkgName, value) {
  if (typeof value !== 'object' || value === null) throw new Error('client-modules: ' + pkgName + ' has a non-object dsh.client declaration');
  const decl = value;
  if (typeof decl.platform !== 'string') throw new Error('client-modules: ' + pkgName + ' dsh.client.platform must be a string');
  const inject = optionalStringArray(pkgName, 'dsh.client.inject', decl.inject);
  const external = optionalStringArray(pkgName, 'dsh.client.external', decl.external);
  if (decl.immediately !== undefined && typeof decl.immediately !== 'boolean') {
    throw new Error('client-modules: ' + pkgName + ' dsh.client.immediately must be a boolean');
  }
  return {
    platform: decl.platform,
    ...(inject !== undefined ? { inject } : {}),
    ...(external !== undefined ? { external } : {}),
    ...(decl.immediately !== undefined ? { immediately: decl.immediately } : {}),
  };
}

function clientExportOf(pkgName, exportsField) {
  const entry = exportsField && exportsField['./client'];
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object' && typeof entry.default === 'string') return entry.default;
  throw new Error('client-modules: ' + pkgName + ' exports["./client"] must be a string or an object with a string default');
}

const decl = normalizeClientDeclaration(manifest.name, manifest.dsh.client);
const clientRelative = clientExportOf(manifest.name, manifest.exports);
const clientAbsolute = path.join(pkgDir, clientRelative);
console.log('DECLARATION=' + JSON.stringify(decl));
console.log('CLIENT_EXPORT=' + clientRelative + ' exists=' + fs.existsSync(clientAbsolute));
console.log('HOST_ENTRY=' + manifest.main + ' exists=' + fs.existsSync(path.join(pkgDir, manifest.main)));
console.log('LOCALES=' + JSON.stringify(['en', 'zh'].map((l) => ({ l, exists: fs.existsSync(path.join(pkgDir, 'locale', l + '.json')) }))));
console.log('BUNDLE_PATCH=' + manifest.dsh.bundle.patch + ' exists=' + fs.existsSync(path.join(pkgDir, manifest.dsh.bundle.patch)));

// resolution through Node's own resolver, exactly as the /plugins route does
const resolved = require.resolve(PKG_NAME + '/client', { paths: [profileDir] });
console.log('REQUIRE_RESOLVE_CLIENT=' + resolved);
const resolvedRoot = require.resolve(PKG_NAME, { paths: [profileDir] });
console.log('REQUIRE_RESOLVE_ROOT=' + resolvedRoot);

// the Host half must be importable and expose apply + inject
import('file:///' + pkgDir.replace(/\\/g, '/') + '/' + manifest.main.replace(/^\.\//, '')).then((mod) => {
  console.log('HOST_EXPORTS=' + Object.keys(mod).join(','));
  console.log('HOST_INJECT=' + JSON.stringify(mod.inject));
  console.log('HOST_APPLY_IS_FUNCTION=' + String(typeof mod.apply === 'function'));
});
