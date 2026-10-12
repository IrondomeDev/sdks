import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const language = process.argv[2];
if (!['javascript', 'python', 'rust', 'go'].includes(language)) throw Error('Unknown language');
const tag = process.env.RELEASE_TAG;
const version = language === 'javascript'
  ? JSON.parse(readFileSync('javascript/package.json', 'utf8')).version
  : language === 'go' ? tag?.replace(/^go\/v/, '')
  : /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(`${language}/${language === 'rust' ? 'Cargo.toml' : 'pyproject.toml'}`, 'utf8'))?.[1];
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version ?? '') || tag !== `${language}/v${version}`) {
  throw Error('Release tag does not match package metadata');
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
const tagged = execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], {encoding:'utf8'}).trim();
if (head !== tagged) throw Error('Checked out commit does not match the release tag');
if (language === 'javascript' && JSON.parse(readFileSync('javascript/package.json')).private) throw Error('npm publication disabled');
if (language === 'rust' && /^publish\s*=\s*false/m.test(readFileSync('rust/Cargo.toml','utf8'))) throw Error('crate publication disabled');
console.log(`Verified ${language} release ${version}`);
