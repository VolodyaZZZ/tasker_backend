import pg from 'pg';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
pool.on('error', (error) => console.error('PostgreSQL pool error', error.code));

export const query = (sql, values) => pool.query(sql, values);

export async function transaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
