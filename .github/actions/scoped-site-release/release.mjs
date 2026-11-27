import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ACCOUNT = "288ed9ea6daf5bd29702d1b90b49cd6b";
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const ACCESS_ISSUER = "https://uniotechnologies.cloudflareaccess.com";
const LOCK_BUCKET = "unio-sites-release-locks";
const HEX_ID = /^[0-9a-f]{32}$/;
const VERSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const AUDIENCE = /^[0-9a-f]{64}$/;
const SITES = {
  "myunio/ultraoffice": { name: "ultraoffice", domain: "ultraoffice.io" },
  "myunio/unio-software": { name: "unio-software", domain: "unio.software" },
};

const env = process.env;
const site = SITES[env.GITHUB_REPOSITORY];
assert.ok(site, "Repository is outside the scoped release allowlist.");
const stage = env.RELEASE_STAGE;
assert.ok(["staging", "production"].includes(stage), "Invalid release stage.");
const workerName = `${site.name}-${stage}`;
const stagingUrl = `https://staging.${site.domain}`;
assert.equal(env.EXPECTED_WORKER, workerName);
assert.equal(env.EXPECTED_ACCOUNT, ACCOUNT);
assert.equal(env.RELEASE_URL, stage === "staging" ? stagingUrl : `https://${site.domain}`);
assert.ok(env.GOOGLE_TOKEN, "Google release credentials are missing.");

const settings = JSON.parse(readFileSync(".github/site-release.json", "utf8"));
assert.equal(settings.accountId, ACCOUNT);
const target = settings[stage];
assert.ok(HEX_ID.test(target.workerId) || VERSION_ID.test(target.workerId), "Pin the live Worker ID in .github/site-release.json.");
assert.ok(HEX_ID.test(target.kvId), "Pin the live FORM_LIMITS namespace ID in .github/site-release.json.");
assert.ok(AUDIENCE.test(settings.staging.accessAudience), "Pin the live staging Access audience.");
assert.equal(typeof settings.staging.verifyHostname, "boolean");
const verifyHostname = settings.staging.verifyHostname;
if (stage === "production") {
  assert.equal(verifyHostname, true, "Verify the staging hostname before releasing to production.");
}

const source = JSON.parse(readFileSync("wrangler.jsonc", "utf8")
  .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match, quoted) => quoted ?? "")
  .replace(/,(\s*[}\]])/g, "$1"));
const { env: stageConfigs, ...base } = source;
const config = { ...base, ...(stage === "staging" ? stageConfigs.staging : {}) };
assert.equal(config.account_id, ACCOUNT);
assert.equal(config.name, workerName);
assert.equal(config.workers_dev, false);
assert.equal(config.preview_urls, false);
assert.ok(!config.routes && !config.route, "Hostnames are managed by OpenTofu.");
assert.ok(!config.kv_namespaces, "The release file owns the FORM_LIMITS namespace ID.");
assert.ok(!existsSync(".wrangler/deploy/config.json"), "A generated Wrangler config would override the review.");
assert.equal(config.vars.OUTPORT_URL, stage === "staging" ? "https://staging.outport.app" : "https://outport.app");
if (stage === "staging") {
  assert.equal(config.assets.run_worker_first, true, "Staging assets must pass through the Access check.");
  config.vars = { ...config.vars, ACCESS_ISSUER, ACCESS_AUDIENCE: target.accessAudience };
}
config.kv_namespaces = [{ binding: "FORM_LIMITS", id: target.kvId }];

async function request(url, token, method = "GET", body) {
  const response = await fetch(url, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(response.ok, `${method} ${new URL(url).pathname} returned ${response.status}.`);
  return response.status === 204 ? undefined : response.json();
}

const accountApi = `${CLOUDFLARE_API}/accounts/${ACCOUNT}`;
const script = `workers/scripts/${workerName}`;
async function cloudflare(path) {
  const data = await request(`${accountApi}/${path}`, env.CLOUDFLARE_API_TOKEN);
  assert.equal(data.success, true, `Cloudflare did not confirm ${path}.`);
  return data.result;
}

async function verifyWorker() {
  const worker = await cloudflare(`workers/workers/${target.workerId}`);
  assert.equal(worker.id, target.workerId);
  assert.equal(worker.name, workerName);
  const subdomain = await cloudflare(`${script}/subdomain`);
  assert.equal(subdomain.enabled, false, "The Worker has a public workers.dev URL.");
  assert.equal(subdomain.previews_enabled, false, "The Worker has public preview URLs.");
}

async function deployment() {
  const { deployments } = await cloudflare(`${script}/deployments`);
  return deployments[0];
}

function wrangler(args, envFile, outputFile) {
  // Use the pinned CLI and only the scoped account/token. Exclude alternate host and auth variables
  // and keep the Google credential outside the Wrangler subprocess.
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(CLOUDFLARE_|CLOUDFLARE$|CF_|WRANGLER_|GOOGLE_|ACTIONS_ID_TOKEN_)/i.test(key)));
  childEnv.CLOUDFLARE_API_TOKEN = env.CLOUDFLARE_API_TOKEN;
  childEnv.CLOUDFLARE_ACCOUNT_ID = ACCOUNT;
  childEnv.CLOUDFLARE_API_BASE_URL = CLOUDFLARE_API;
  childEnv.CLOUDFLARE_BASE_URL = CLOUDFLARE_API;
  childEnv.WRANGLER_SEND_METRICS = "false";
  if (outputFile) childEnv.WRANGLER_OUTPUT_FILE_PATH = outputFile;
  execFileSync("npx", ["--yes", "wrangler@4.164.0", ...args, "--env-file", envFile], { env: childEnv, stdio: "inherit" });
}

function siteRequest(path, headers = {}) {
  return fetch(new URL(path, stagingUrl), {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
}

async function verifyStaging() {
  for (const path of ["/", "/site.css", "/api/lead/"]) {
    const response = await siteRequest(path);
    const location = response.headers.get("location");
    assert.ok(response.status >= 300 && response.status < 400 && location &&
      new URL(location, stagingUrl).origin === ACCESS_ISSUER &&
      new URL(location, stagingUrl).pathname.startsWith("/cdn-cgi/access/login/"),
    `${path} did not return the Unio Access challenge.`);
  }
  if (site.name === "ultraoffice") {
    const versions = settings.staging.accessVersions;
    async function accessSecret(kind, version) {
      assert.ok(Number.isSafeInteger(version) && version > 0, `Pin the Secret Manager version for ${kind}.`);
      const secret = `tofu-sites-runtime-tf-var-ultraoffice-staging-inbound-access-${kind}`;
      const url = `https://secretmanager.googleapis.com/v1/projects/opentofu-state-unio/secrets/${secret}/versions/${version}:access`;
      const result = await request(url, env.GOOGLE_TOKEN);
      assert.ok(result.payload?.data, `Secret Manager returned an empty ${kind}.`);
      return Buffer.from(result.payload.data, "base64").toString("utf8");
    }
    const [id, secret] = await Promise.all([
      accessSecret("client-id", versions?.clientId),
      accessSecret("client-secret", versions?.clientSecret),
    ]);
    const response = await siteRequest("/", { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret });
    assert.equal(response.status, 200, "UltraOffice staging did not accept the checked Access pair.");
  }
}

async function release() {
  assert.ok(env.CLOUDFLARE_API_TOKEN, "The scoped Cloudflare token is missing.");
  const name = `${workerName}.lock`;
  const query = new URLSearchParams({ uploadType: "media", name, ifGenerationMatch: "0" });
  const lock = await request(`https://storage.googleapis.com/upload/storage/v1/b/${LOCK_BUCKET}/o?${query}`,
    env.GOOGLE_TOKEN, "POST", { holder: `${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` });
  assert.match(lock.generation, /^[0-9]+$/);
  try {
    await verifyWorker();
    const before = await deployment();
    const configPath = `.wrangler-release-${env.GITHUB_RUN_ID}.json`;
    writeFileSync(configPath, JSON.stringify(config), { flag: "wx" });
    const work = mkdtempSync(join(tmpdir(), "site-release-"));
    const trustedEnv = join(work, "release.env");
    writeFileSync(trustedEnv, "", { flag: "wx", mode: 0o600 });
    const output = join(work, "output.ndjson");
    wrangler(["versions", "upload", "--config", configPath, "--message", env.GITHUB_SHA], trustedEnv, output);
    const uploads = readFileSync(output, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      .filter(({ type }) => type === "version-upload");
    assert.equal(uploads.length, 1, "Expected one uploaded Worker version.");
    const version = uploads[0].version_id;
    assert.ok(VERSION_ID.test(version), "Wrangler did not report the uploaded version ID.");
    const uploaded = await cloudflare(`${script}/versions/${version}`);
    const bindings = uploaded.resources?.bindings ?? [];
    const kv = bindings.filter(({ type, name }) => type === "kv_namespace" && name === "FORM_LIMITS");
    assert.equal(kv.length, 1);
    assert.equal(kv[0].namespace_id, target.kvId, "Uploaded version has the wrong FORM_LIMITS namespace.");
    assert.deepEqual(await deployment(), before, "The active deployment changed during upload.");
    wrangler(["versions", "deploy", `${version}@100%`, "--config", configPath, "--yes"], trustedEnv);
    const active = await deployment();
    assert.equal(active?.versions.length, 1);
    assert.equal(active.versions[0].version_id, version);
    assert.equal(active.versions[0].percentage, 100);
    await verifyWorker();
    appendFileSync(env.GITHUB_OUTPUT, `verify_hostname=${verifyHostname}\n`);
    console.log(`Deployed ${workerName} version ${version} at 100%.`);
  } finally {
    await request(`https://storage.googleapis.com/storage/v1/b/${LOCK_BUCKET}/o/${name}?ifGenerationMatch=${lock.generation}`,
      env.GOOGLE_TOKEN, "DELETE");
  }
}

if (env.RELEASE_OPERATION === "smoke") {
  assert.ok(stage === "staging" && verifyHostname, "Staging hostname verification is disabled.");
  await verifyStaging();
} else {
  assert.equal(env.RELEASE_OPERATION, "deploy");
  await release();
}
