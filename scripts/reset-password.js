// Istemal: node scripts/reset-password.js email@example.com NayaPassword123
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { hashPassword } from '../src/util.js';

const [mail, pass] = process.argv.slice(2);
if (!mail || !pass || pass.length < 10) {
  console.error('Istemal: node scripts/reset-password.js <email> <naya password, 10+ characters>');
  process.exit(1);
}
const db = openDb(loadConfig().dbPath);
const user = db.get('SELECT id FROM users WHERE email = ?', mail.toLowerCase());
if (!user) { console.error('Is email ka account nahi mila'); process.exit(1); }
db.run('UPDATE users SET pass_hash = ? WHERE id = ?', hashPassword(pass), user.id);
db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
console.log('Password badal gaya');
