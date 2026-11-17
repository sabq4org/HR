import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../server/app.js';
import { createDatabase, todayInRiyadh } from '../../server/database.js';

// Synthetic personas only (decision 023: document number, issue date, expiry follow-up).
const personas = { employee: 'emp-sara', manager: 'emp-omar', hr: 'emp-noura' } as const;
type Persona = keyof typeof personas;
const pdf = Buffer.from('%PDF-1.4 synthetic').toString('base64');
const plus = (n: number) => {
  const d = new Date(`${todayInRiyadh()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function harness() {
  const db = await createDatabase();
  const server = createServer(createApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const cookies = new Map<Persona, string>();
  async function call(role: Persona, method: string, path: string, body?: unknown) {
    if (!cookies.has(role)) {
      const login = await fetch(`${origin}/api/demo/session`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ employeeId: personas[role] }),
      });
      assert.equal(login.status, 200);
      cookies.set(role, login.headers.get('set-cookie')!.split(';')[0]);
    }
    return fetch(`${origin}/api${path}`, {
      method,
      headers: {
        origin,
        cookie: cookies.get(role)!,
        ...(body === undefined
          ? {}
          : { 'content-type': 'application/json', 'idempotency-key': randomUUID() }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const upload = (body: Record<string, unknown>) =>
    call('hr', 'POST', `/admin/employees/${personas.employee}/documents`, {
      filename: 'iqama.pdf',
      mimeType: 'application/pdf',
      contentBase64: pdf,
      ...body,
    });
  return {
    db,
    call,
    upload,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    },
  };
}

test('an expiring document needs its expiry; number and optional issue date are kept, number encrypted', async () => {
  const h = await harness();
  try {
    const missing = await h.upload({ category: 'identity', documentNumber: '2123456789' });
    assert.equal(missing.status, 400);
    assert.match(await missing.text(), /EXPIRY_REQUIRED/);
    const backwards = await h.upload({
      category: 'identity',
      issuedAt: plus(10),
      expiresAt: plus(5),
    });
    assert.equal(backwards.status, 400);
    const noExpiryNeeded = await h.upload({ category: 'qualification' });
    assert.equal(noExpiryNeeded.status, 201);

    const created = await h.upload({
      category: 'identity',
      documentNumber: ' 2123456789 ',
      expiresAt: plus(10),
    });
    assert.equal(created.status, 201, await created.clone().text());
    const doc = (
      (await created.json()) as {
        document: { id: string; documentNumber: string; issuedAt: null; expiresAt: string };
      }
    ).document;
    assert.equal(doc.documentNumber, '2123456789');
    assert.equal(doc.issuedAt, null);
    const raw = (
      await h.db.read<{ document_number_encrypted: string }>(
        'SELECT document_number_encrypted FROM employee_documents WHERE id=?',
        [doc.id],
      )
    )[0];
    assert.ok(raw.document_number_encrypted);
    assert.doesNotMatch(raw.document_number_encrypted, /2123456789/);
  } finally {
    await h.close();
  }
});

test('HR follow-up lists expired and soon-to-expire items with days left; renewal updates in place', async () => {
  const h = await harness();
  try {
    const expired = await h.upload({ category: 'passport', expiresAt: plus(-3) });
    const soon = await h.upload({
      category: 'identity',
      documentNumber: '2000000001',
      expiresAt: plus(7),
    });
    const far = await h.upload({ category: 'press_card', expiresAt: plus(400) });
    for (const r of [expired, soon, far]) assert.equal(r.status, 201);
    const soonDoc = ((await soon.json()) as { document: { id: string; version: number } }).document;

    // A date entered in the employee file counts too, unless a document of that kind covers it.
    const file = (
      (await (await h.call('hr', 'GET', `/admin/employees/${personas.manager}`)).json()) as {
        file: { version: number };
      }
    ).file;
    const saved = await h.call('hr', 'PATCH', `/admin/employees/${personas.manager}`, {
      version: file.version,
      values: { nationalIdExpiry: plus(20) },
      reason: 'synthetic iqama date',
    });
    assert.equal(saved.status, 200, await saved.clone().text());

    const list = await h.call('hr', 'GET', '/admin/expiries');
    assert.equal(list.status, 200);
    const { items } = (await list.json()) as {
      items: {
        title: string;
        daysLeft: number;
        source: string;
        employeeId: string;
        documentNumber: string | null;
      }[];
    };
    assert.deepEqual(
      items.map((i) => [i.employeeId, i.title, i.daysLeft, i.source]),
      [
        [personas.employee, 'جواز السفر', -3, 'document'],
        [personas.employee, 'الهوية / الإقامة', 7, 'document'],
        [personas.manager, 'الهوية / الإقامة', 20, 'profile'],
      ],
    );
    assert.equal(items[1].documentNumber, '2000000001');

    // Others cannot read the follow-up.
    assert.equal((await h.call('employee', 'GET', '/admin/expiries')).status, 403);
    assert.equal((await h.call('manager', 'GET', '/admin/expiries')).status, 403);

    // Renewal: new number and expiry, with a reason, on the current version only.
    const renewed = await h.call('hr', 'PATCH', `/admin/documents/${soonDoc.id}`, {
      version: soonDoc.version,
      reason: 'تجديد الإقامة',
      documentNumber: '2000000001',
      issuedAt: plus(0),
      expiresAt: plus(365),
    });
    assert.equal(renewed.status, 200, await renewed.clone().text());
    const stale = await h.call('hr', 'PATCH', `/admin/documents/${soonDoc.id}`, {
      version: soonDoc.version,
      reason: 'again',
      expiresAt: plus(30),
    });
    assert.equal(stale.status, 409);
    const unchanged = await h.call('hr', 'PATCH', `/admin/documents/${soonDoc.id}`, {
      version: soonDoc.version + 1,
      reason: 'nothing',
      documentNumber: '2000000001',
      issuedAt: plus(0),
      expiresAt: plus(365),
    });
    assert.equal(unchanged.status, 400);
    const events = await h.db.read<{ action: string; details_json: string; reason: string }>(
      "SELECT action,details_json,reason FROM administration_events WHERE resource_id=? AND action='document_details_updated'",
      [soonDoc.id],
    );
    assert.equal(events.length, 1);
    assert.ok(events[0].reason);
    assert.doesNotMatch(events[0].details_json, /2000000001/);
    const after = (
      (await (await h.call('hr', 'GET', '/admin/expiries')).json()) as {
        items: { title: string }[];
      }
    ).items;
    assert.equal(after.length, 2);
    // The employee cannot change their own document details.
    assert.equal(
      (
        await h.call('employee', 'PATCH', `/admin/documents/${soonDoc.id}`, {
          version: soonDoc.version + 1,
          reason: 'x',
          expiresAt: plus(9),
        })
      ).status,
      403,
    );
  } finally {
    await h.close();
  }
});

// Decision 024: an optional renewal fee per expiring document, stored in halalas.
test('renewal fee is optional, parsed from riyals, totalled in the follow-up and kept in the trail', async () => {
  const h = await harness();
  try {
    const bad = await h.upload({ category: 'identity', expiresAt: plus(5), renewalFee: 'abc' });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /INVALID_FEE/);
    const negative = await h.upload({ category: 'identity', expiresAt: plus(5), renewalFee: '-5' });
    assert.equal(negative.status, 400);
    const withFee = await h.upload({
      category: 'identity',
      expiresAt: plus(5),
      renewalFee: '1,500.5',
    });
    assert.equal(withFee.status, 201, await withFee.clone().text());
    const doc = (
      (await withFee.json()) as {
        document: { id: string; version: number; renewalFeeHalalas: number | null };
      }
    ).document;
    assert.equal(doc.renewalFeeHalalas, 150050);
    const noFee = await h.upload({ category: 'passport', expiresAt: plus(8) });
    assert.equal(noFee.status, 201);
    assert.equal(
      ((await noFee.json()) as { document: { renewalFeeHalalas: number | null } }).document
        .renewalFeeHalalas,
      null,
    );

    const { items } = (await (await h.call('hr', 'GET', '/admin/expiries')).json()) as {
      items: { documentId: string | null; renewalFeeHalalas: number | null }[];
    };
    assert.deepEqual(
      items.map((i) => i.renewalFeeHalalas),
      [150050, null],
    );

    // Arabic digits are accepted; the change is recorded with from/to.
    const updated = await h.call('hr', 'PATCH', `/admin/documents/${doc.id}`, {
      version: doc.version,
      reason: 'رسوم السنة القادمة',
      expiresAt: plus(5),
      renewalFee: '٦٥٠',
    });
    assert.equal(updated.status, 200, await updated.clone().text());
    assert.equal(
      ((await updated.json()) as { document: { renewalFeeHalalas: number } }).document
        .renewalFeeHalalas,
      65000,
    );
    const events = await h.db.read<{ details_json: string }>(
      "SELECT details_json FROM administration_events WHERE resource_id=? AND action='document_details_updated'",
      [doc.id],
    );
    assert.deepEqual(JSON.parse(events[0].details_json).renewalFeeHalalas, {
      from: 150050,
      to: 65000,
    });
  } finally {
    await h.close();
  }
});

// Decision 024: the system owner may edit his own file, except salary and bank.
test('the system owner edits his own file and documents, but not his own salary or bank', async () => {
  const h = await harness();
  try {
    await h.db.execute(
      'INSERT INTO system_owners(employee_id,granted_at,granted_reason) VALUES(?,?,?)',
      [personas.hr, new Date().toISOString(), 'synthetic owner'],
    );
    const own = (await (await h.call('hr', 'GET', `/admin/employees/${personas.hr}`)).json()) as {
      file: { version: number; editable: boolean; ownerSelfEdit?: boolean };
    };
    assert.equal(own.file.editable, true);
    assert.equal(own.file.ownerSelfEdit, true);
    const saved = await h.call('hr', 'PATCH', `/admin/employees/${personas.hr}`, {
      version: own.file.version,
      values: { nationalIdExpiry: plus(40) },
      reason: 'تحديث ملفي',
    });
    assert.equal(saved.status, 200, await saved.clone().text());
    const pay = await h.call('hr', 'PATCH', `/admin/employees/${personas.hr}`, {
      version: own.file.version + 1,
      values: { bankName: 'Synthetic Owner Bank 024' },
      reason: 'x',
    });
    assert.equal(pay.status, 403);
    assert.match(await pay.text(), /OWNER_SELF_FINANCIAL/);
    const ownDoc = await h.call('hr', 'POST', `/admin/employees/${personas.hr}/documents`, {
      category: 'passport',
      filename: 'passport.pdf',
      mimeType: 'application/pdf',
      contentBase64: pdf,
      expiresAt: plus(90),
    });
    assert.equal(ownDoc.status, 201, await ownDoc.clone().text());
    const events = await h.db.read<{ details_json: string }>(
      "SELECT details_json FROM administration_events WHERE resource_id=? AND action='profile_updated'",
      [personas.hr],
    );
    assert.ok(events.some((e) => JSON.parse(e.details_json).selfEdit === true));
  } finally {
    await h.close();
  }
});

test('an HR account that is not the owner still cannot edit its own file', async () => {
  const h = await harness();
  try {
    const own = (await (await h.call('hr', 'GET', `/admin/employees/${personas.hr}`)).json()) as {
      file: { version: number; editable: boolean; ownerSelfEdit?: boolean };
    };
    assert.equal(own.file.editable, false);
    assert.equal(own.file.ownerSelfEdit, undefined);
    const saved = await h.call('hr', 'PATCH', `/admin/employees/${personas.hr}`, {
      version: own.file.version,
      values: { nationalIdExpiry: plus(40) },
      reason: 'x',
    });
    assert.equal(saved.status, 403);
  } finally {
    await h.close();
  }
});

test('an open renewal protects the source expiry, and its evidence remains available after completion', async () => {
  const h = await harness();
  try {
    const source = (await (await h.upload({ category: 'identity', expiresAt: plus(4) })).json())
      .document;
    const proof = (await (await h.upload({ category: 'renewal_proof' })).json()).document;
    const opened = await h.call('hr', 'POST', '/admin/renewals', {
      documentId: source.id,
      documentVersion: source.version,
      assignedTo: personas.hr,
    });
    assert.equal(opened.status, 201);
    const renewal = (await opened.json()).case;
    for (const [method, suffix, fields] of [
      ['PATCH', '', { expiresAt: plus(40) }],
      ['POST', '/archive', {}],
    ] as const) {
      const res = await h.call('hr', method, '/admin/documents/' + source.id + suffix, {
        version: source.version,
        reason: 'فحص اصطناعي',
        ...fields,
      });
      assert.equal(res.status, 409);
      assert.equal((await res.json()).error.code, 'OPEN_RENEWAL');
    }
    const complete = await h.call('hr', 'POST', '/admin/renewals/' + renewal.id + '/complete', {
      version: renewal.version,
      documentVersion: source.version,
      proofDocumentId: proof.id,
      newExpiry: plus(400),
      payment: 'none',
      reason: 'إثبات اصطناعي',
    });
    assert.equal(complete.status, 200, await complete.clone().text());
    const archived = await h.call('hr', 'POST', '/admin/documents/' + proof.id + '/archive', {
      version: proof.version,
      reason: 'فحص اصطناعي',
    });
    assert.equal(archived.status, 409);
    assert.equal((await archived.json()).error.code, 'RENEWAL_PROOF_IN_USE');
    const download = await h.call('hr', 'GET', '/admin/documents/' + proof.id + '/download');
    assert.equal(download.status, 200);
    assert.ok(Buffer.from(await download.arrayBuffer()).equals(Buffer.from(pdf, 'base64')));
  } finally {
    await h.close();
  }
});
