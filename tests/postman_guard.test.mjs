// Tests the actual shipped Postman guards without HTTP, secrets or database
// access. The collection SDK models are real; JWT payloads below are synthetic
// and are used only to exercise request-scope checks before transmission.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const newmanRequire = createRequire(require.resolve('newman'));
const { Request } = newmanRequire('postman-collection');
const directory = new URL('./postman/', import.meta.url);
const main = JSON.parse(fs.readFileSync(new URL('fcom.postman_collection.json', directory), 'utf8'));
const smoke = JSON.parse(fs.readFileSync(new URL('fcom.api-contract-smoke.postman_collection.json', directory), 'utf8'));
const items = collection => collection.item.flatMap(item => item.item ?? [item]);
const itemWith = (collection, prefix) => structuredClone(items(collection).find(item => item.name.startsWith(prefix)));
const token = id => [Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({ sub: id })).toString('base64url'), 'synthetic-signature'].join('.');

function fixture(collection) {
  const prefix = 'postman_0123456789ab';
  const names = ['alice','bob','carol','dave','eve','frank','grace'];
  const userIds = Object.fromEntries(names.map(name => [name,crypto.randomUUID()]));
  const collectionValues = Object.fromEntries(collection.variable.map(item => [item.key,item.value]));
  const environment = {
    base_url: 'https://vzjlhiqvfgrrlfdgyebx.supabase.co/functions/v1',
    supabase_url: 'https://vzjlhiqvfgrrlfdgyebx.supabase.co',
    test_environment: 'isolated-production-fixtures', allow_production_fixtures: 'true',
    fcom_fixture_prefix: prefix, fixture_user_ids: JSON.stringify(Object.values(userIds)),
    group_id: crypto.randomUUID(), report_id: crypto.randomUUID(),
    bob_invite_id: crypto.randomUUID(), carol_invite_id: crypto.randomUUID(),
    unknown_phone: '+9991234567899', new_phone: '+9991234567898', bob_phone: '+9991234567891', dave_phone: '+9991234567893',
    missing_user_id: crypto.randomUUID(),
  };
  for (const name of names) { environment[name + '_id'] = userIds[name]; environment[name + '_nickname'] = prefix + '_' + name; }
  for (const name of ['alice','bob','carol']) environment[name + '_token'] = token(userIds[name]);
  environment.admin_token = token(userIds.alice);
  environment.logout_token = token(userIds.carol);
  environment.revoked_token = token(userIds.alice);
  for (const key of ['new_user_id','phone_user_id','first_school_user_id','reject_user_id']) {
    environment[key] = crypto.randomUUID(); environment[key + '_fixture_prefix'] = prefix;
  }
  environment.reg_token = token(environment.new_user_id);
  environment.group_fixture_verified = environment.group_id;
  environment.report_fixture_verified = environment.report_id;
  for (const key of ['new_user_fullName','phone_user_fullName','first_user_fullName','reject_user_fullName','validation_fullName','duplicate_alice_fullName','duplicate_bob_fullName']) environment[key] = prefix + ' ' + key;
  for (const key of ['new_user_nickname','phone_user_nickname','first_user_nickname','reject_user_nickname','validation_nickname','duplicate_bob_nickname','clone_nickname','unknown_nickname']) environment[key] = prefix + '_' + key;
  environment.alice_nickname_upper = environment.alice_nickname.toUpperCase();
  environment.alice_fullName_lower = prefix + ' alice';
  environment.admin_school = prefix + ' School A';
  environment.smoke_stale_target_id = userIds.eve;
  environment.smoke_partner_id = userIds.alice;
  const disposableId = crypto.randomUUID();
  Object.assign(collectionValues, {
    contract_token: token(userIds.bob), contract_caller_id: userIds.bob,
    contract_disposable_id: disposableId, contract_disposable_token: token(disposableId),
    contract_disposable_verified: disposableId, contract_disposable_nickname: prefix + '_delete_' + 'a'.repeat(32),
  });
  return { collection, collectionValues, environment, local: {}, userIds };
}

function execute(state, item, includeItem = true) {
  const request = new Request(item.request);
  let skipped = false;
  const get = key => state.local[key] ?? state.environment[key] ?? state.collectionValues[key];
  const replaceIn = value => String(value).replace(/\{\{([^{}]+)\}\}/g, (_, key) => {
    if (key === '$guid') return crypto.randomUUID();
    if (key === '$timestamp') return String(Math.floor(Date.now()/1000));
    return get(key) ?? '{{' + key + '}}';
  });
  const scope = values => ({ get: key => values[key], set: (key,value) => { values[key] = value; }, unset: key => { delete values[key]; } });
  const pm = {
    info: { requestName: item.name }, request,
    variables: { get, set: (key,value) => { state.local[key] = value; }, replaceIn },
    environment: scope(state.environment), collectionVariables: scope(state.collectionValues),
    execution: { skipRequest: () => { skipped = true; } },
  };
  const context = { pm, require, console, Buffer };
  let error;
  try {
    // Postman's sandbox provides Buffer and executes collection/item callbacks
    // in a shared scope. Compiling each separately missed a real collision.
    const scripts = ['const Buffer = globalThis.Buffer;'];
    for (const event of state.collection.event ?? []) if (event.listen === 'prerequest') scripts.push(event.script.exec.join('\n'));
    if (includeItem) for (const event of item.event ?? []) if (event.listen === 'prerequest') scripts.push(event.script.exec.join('\n'));
    vm.runInNewContext(scripts.join('\n'), context);
  } catch (caught) { error = caught; }
  return { request, skipped, error };
}

function refused(result) {
  assert.ok(result.error, 'unsafe request must fail');
  assert.equal(result.skipped, true, 'unsafe request must be skipped');
  assert.ok(String(result.request.url).startsWith('http://127.0.0.1:1/'), 'fallback must never transmit to the original target');
}

test('Every collection and item script compiles', () => {
  for (const collection of [main,smoke]) {
    for (const event of collection.event ?? []) new Function(event.script.exec.join('\n'));
    for (const item of items(collection)) for (const event of item.event ?? []) new Function(event.script.exec.join('\n'));
  }
});

test('Combined collection and item scripts coexist with sandbox declarations', () => {
  for (const collection of [main,smoke]) {
    for (const item of items(collection)) {
      const state = fixture(collection);
      const result = execute(state,item);
      assert.equal(result.error, undefined, item.name + ' must execute its combined guards');
      assert.equal(result.skipped, false, item.name + ' must retain guard checks without false skipping');
    }
  }
});

test('All 119 SDK request URLs resolve to absolute HTTPS including query parameters', () => {
  let checked = 0;
  for (const collection of [main,smoke]) {
    const state = fixture(collection);
    for (const item of items(collection)) {
      const sdkUrl = String(new Request(item.request).url);
      const resolved = sdkUrl.replace(/\{\{([^{}]+)\}\}/g, (_, key) => {
        const value = state.environment[key] ?? state.collectionValues[key];
        assert.notEqual(value, undefined, 'URL variable must resolve: ' + key);
        return value;
      });
      const url = new URL(resolved);
      assert.equal(url.protocol, 'https:', item.name);
      assert.equal(url.hostname, 'vzjlhiqvfgrrlfdgyebx.supabase.co', item.name);
      assert.ok(url.pathname.startsWith('/functions/v1/') || url.pathname.startsWith('/rest/v1/'), item.name);
      if (item.name.startsWith('M-02 ')) {
        assert.equal(url.pathname, '/functions/v1/messages');
        assert.equal(url.searchParams.get('partnerId'), state.userIds.bob);
      }
      if (item.name.startsWith('SC-05 ')) {
        assert.equal(url.searchParams.get('partnerId'), state.userIds.alice);
        assert.equal(url.searchParams.get('limit'), '10');
      }
      checked++;
    }
  }
  assert.equal(checked, 119);
});

test('Production requires explicit permission flag, seven non-seed ids and prefixed actors', () => {
  for (const collection of [main,smoke]) {
    const item = itemWith(collection, collection === main ? 'SB-05 ' : 'SC-06 ');
    for (const mutate of [
      state => { state.environment.allow_production_fixtures = 'false'; },
      state => { state.environment.fixture_user_ids = '[]'; },
      state => { state.environment.bob_nickname = 'real_person'; },
      state => { state.environment.bob_id = '00000000-0000-0000-0000-000000000002'; },
      state => { state.environment.test_environment = 'disposable-staging'; },
    ]) {
      const state = fixture(collection); mutate(state); refused(execute(state,item));
    }
  }
});

test('Production rejects a real/App Review actor or body target outside fixtures', () => {
  const state = fixture(main);
  const item = itemWith(main,'SB-05 ');
  state.environment.bob_token = token(crypto.randomUUID());
  refused(execute(state,item));
  const targetState = fixture(main);
  item.request.body.raw = JSON.stringify({ targetId: crypto.randomUUID(), action: 'block' });
  refused(execute(targetState,item));
});

test('Registration ids require this namespace provenance before password reset', () => {
  const state = fixture(main);
  delete state.environment.new_user_id_fixture_prefix;
  refused(execute(state,itemWith(main,'P-01 ')));
  const good = fixture(main);
  assert.equal(execute(good,itemWith(main,'P-01 ')).error, undefined);
});

test('Direct PostgREST writes cannot replace captured group/member/invite filters', () => {
  for (const [prefix,field] of [['GT-03 ','groupId'],['GT-04 ','id'],['GT-07 ','id'],['GT-08 ','id']]) {
    const state = fixture(main);
    const item = itemWith(main,prefix);
    assert.equal(execute(state,item).error, undefined, 'fixture filter should be admitted');
    const foreign = crypto.randomUUID();
    item.request.url = item.request.url.replace(field + '=eq.{{' + (prefix === 'GT-04 ' ? 'bob_invite_id' : 'group_id') + '}}', field + '=eq.' + foreign);
    refused(execute(state,item));
  }
});

test('Known read-only bad JWT cases and generated-account prerequisites remain runnable', () => {
  for (const prefix of ['S-03 ','S-05 ']) assert.equal(execute(fixture(main),itemWith(main,prefix)).error, undefined);
  for (const prefix of ['SC-07 ','SC-08 ']) assert.equal(execute(fixture(smoke),itemWith(smoke,prefix)).error, undefined);
});

test('Disposable deletion refuses an approved fixture token or unverified account', () => {
  const item = itemWith(smoke,'SC-11 ');
  const original = fixture(smoke);
  assert.equal(execute(original,item).error, undefined);
  const mismatch = fixture(smoke);
  mismatch.collectionValues.contract_disposable_token = token(mismatch.userIds.bob);
  refused(execute(mismatch,item));
  const unverified = fixture(smoke);
  delete unverified.collectionValues.contract_disposable_verified;
  refused(execute(unverified,item));
});

test('Local mode cannot transmit to a hosted URL', () => {
  const state = fixture(main);
  state.environment.test_environment = 'local';
  refused(execute(state,itemWith(main,'M-01 ')));
  state.environment.base_url = 'http://localhost:54321/functions/v1';
  assert.equal(execute(state,itemWith(main,'M-01 ')).error, undefined);
});
