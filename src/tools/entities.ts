// Customer and project CRUD (/customers, /projects). Reads are any-staff;
// create/update/delete are admin-only server-side (a non-admin device token
// gets a 403). Project LISTING lives in helpers.ts (tempo_list_projects) — this
// module adds the write side plus customer read/write.

import { api } from '../api.js';

interface Customer {
  id: number; name: string; ad_hoc_hourly_rate: number; is_internal: number;
  stripe_customer_id: string | null; mercury_customer_id: string | null;
}

interface Project { id: number; customer_id: number | null; code: string | null; name: string; archived_at?: string | null }

// --- Customers ---

export async function listCustomers(opts: { query?: string; include_internal?: boolean } = {}): Promise<string> {
  let rows = await api.get<Customer[]>('/customers');
  if (opts.include_internal === false) rows = rows.filter((c) => !c.is_internal);
  if (opts.query) {
    const q = opts.query.toLowerCase();
    rows = rows.filter((c) => c.name.toLowerCase().includes(q));
  }
  if (rows.length === 0) return opts.query ? `No customers matching "${opts.query}".` : 'No customers.';
  const header = 'id   name';
  return [header, ...rows.map((c) => {
    const flags = [c.is_internal ? 'internal' : '', c.ad_hoc_hourly_rate ? `$${c.ad_hoc_hourly_rate}/hr` : ''].filter(Boolean).join(' · ');
    return `${String(c.id).padEnd(4)} ${c.name}${flags ? `  (${flags})` : ''}`;
  })].join('\n');
}

export async function createCustomer(opts: { name: string; ad_hoc_hourly_rate?: number; is_internal?: boolean }): Promise<string> {
  const res = await api.post<{ ok: boolean; id: number }>('/customers', opts);
  return `Created customer #${res.id}: ${opts.name}`;
}

export async function updateCustomer(opts: { id: number; name?: string; ad_hoc_hourly_rate?: number; is_internal?: boolean }): Promise<string> {
  const { id, ...fields } = opts;
  await api.put(`/customers/${id}`, fields);
  return `Updated customer #${id}.`;
}

export async function deleteCustomer(opts: { id: number }): Promise<string> {
  await api.delete(`/customers/${opts.id}`);
  return `Deleted customer #${opts.id}.`;
}

// --- Projects (write side; list is tempo_list_projects in helpers.ts) ---

export async function createProject(opts: { customer_id: number; code: string; name: string }): Promise<string> {
  await api.post('/projects', opts);
  return `Created project ${opts.code} — ${opts.name} (customer #${opts.customer_id}).`;
}

export async function updateProject(opts: { id: number; code?: string; name?: string }): Promise<string> {
  // The API's PUT replaces both code and name, so merge with current values to
  // support partial edits (change just the name, etc.).
  const projects = await api.get<Project[]>('/projects');
  const current = projects.find((p) => p.id === opts.id);
  if (!current) return `Project #${opts.id} not found.`;
  const code = opts.code ?? current.code ?? '';
  const name = opts.name ?? current.name ?? '';
  await api.put(`/projects/${opts.id}`, { code, name });
  return `Updated project #${opts.id} (${code} — ${name}).`;
}

export async function deleteProject(opts: { id: number }): Promise<string> {
  await api.delete(`/projects/${opts.id}`);
  return `Deleted project #${opts.id}.`;
}
