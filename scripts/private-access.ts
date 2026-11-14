// Local-only role and manager administration for the private database.
// Usage:
//   npm run private:access -- list
//   npm run private:access -- incomplete   (people imported with placeholder email/join date)
//   npm run private:access -- grant <email|employeeNumber> <hr|manager|finance|approver|auditor|employee>
//   npm run private:access -- manager <email|employeeNumber> <managerEmail|managerNumber>
// Every change is written to the append-only audit log. See docs/private-local.md.
import { resolve } from 'node:path';
import { createDatabase } from '../server/database.js';
import {
  grantRole,
  listAccess,
  listIncomplete,
  setManager,
} from '../server/private/local-admin.js';

if (process.env.HR_MODE) throw new Error('Private access tools never run in a hosted mode.');
const [command, a, b] = process.argv.slice(2);
const db = await createDatabase(resolve(process.env.HR_DB_PATH ?? '.data/hr-private.sqlite'), {
  seed: false,
});
try {
  if (command === 'list') console.table(await listAccess(db));
  else if (command === 'incomplete')
    console.table((await listIncomplete(db)).map((r) => ({ ...r, fields: r.fields.join(', ') })));
  else if (command === 'grant' && a && b) {
    await grantRole(db, a, b);
    console.log(`Granted ${b}.`);
  } else if (command === 'manager' && a && b) {
    await setManager(db, a, b);
    console.log('Manager assigned.');
  } else
    throw new Error(
      'Usage: private:access -- list | incomplete | grant <who> <role> | manager <who> <managerWho>',
    );
} finally {
  await db.close();
}
