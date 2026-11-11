// Verifies JDK detection on macOS. Does not download anything.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { getSystemJavaInfo, findInstalledJdks } = require('../main-process/utils/jdk-utils');

function check(name, fn) {
  try {
    const detail = fn();
    console.log('PASS', name + (detail ? `: ${detail}` : ''));
  } catch (error) {
    console.log('FAIL', name + `: ${error.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  const system = await getSystemJavaInfo();

  check('getSystemJavaInfo() finds a JDK', () => {
    assert.ok(system, 'no system Java detected');
    assert.strictEqual(system.isDefault, true);
    return system.path;
  });

  check('system JDK is Java 17+', () => {
    assert.ok(system, 'no system Java detected');
    const major = parseInt(system.version.split('.')[0], 10);
    assert.ok(major >= 17, `expected 17+, got ${system.version}`);
    return system.version;
  });

  check('system JDK home contains bin/java', () => {
    assert.ok(system, 'no system Java detected');
    const javaBin = path.join(system.path, 'bin', 'java');
    assert.ok(fs.existsSync(javaBin), `missing ${javaBin}`);
    return javaBin;
  });

  const jdks = await findInstalledJdks();

  check('findInstalledJdks() includes the system JDK', () => {
    assert.ok(system, 'no system Java detected');
    const match = jdks.find((jdk) => jdk.path === system.path);
    assert.ok(match, `system JDK ${system.path} not listed`);
    return `${jdks.length} JDK(s)`;
  });

  check('findInstalledJdks() returns well-formed, unique entries', () => {
    for (const jdk of jdks) {
      assert.ok(jdk.version, `missing version for ${jdk.path}`);
      assert.ok(jdk.path, 'missing path');
      assert.strictEqual(typeof jdk.isDefault, 'boolean');
    }
    const paths = jdks.map((jdk) => jdk.path);
    assert.strictEqual(new Set(paths).size, paths.length, 'duplicate paths present');
    return paths.join(', ');
  });
})().catch((error) => {
  console.log('FAIL', error.message);
  process.exitCode = 1;
});
