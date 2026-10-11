// Thin project organisation, shared with the client. IDs survive renames.
export interface Space { id: string; name: string }
export function migrateSpaces(raw: unknown): Space[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>(), names = new Set<string>();
  return raw.filter(s => {
    if (!s || typeof s.id !== 'string' || !/^[\w-]{1,80}$/.test(s.id) || typeof s.name !== 'string' || !s.name.trim() || s.name.trim().length > 40 || ids.has(s.id) || names.has(s.name.trim().toLowerCase())) return false;
    ids.add(s.id); names.add(s.name.trim().toLowerCase()); return true;
  }).map(s => ({ id: s.id, name: s.name.trim() }));
}
export function spaceName(value: unknown, spaces: Space[], except?: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 40) throw new Error('Use a space name between 1 and 40 characters');
  const name = value.trim();
  if (spaces.some(s => s.id !== except && s.name.toLowerCase() === name.toLowerCase())) throw new Error('A space with that name already exists');
  return name;
}
export function assignSpace(project: { space?: string }, space: unknown, spaces: Space[]) {
  if (space === null || space === '') { delete project.space; return; }
  if (typeof space !== 'string' || !spaces.some(s => s.id === space)) throw new Error('Space not found');
  project.space = space;
}
export function inSpace(project: { space?: string } | undefined, active: string): boolean {
  return !active || project?.space === active;
}
export function activeSpace(active: string, spaces: Space[]): string {
  return spaces.some(s => s.id === active) ? active : '';
}
export function cycleSpace(active: string, spaces: Space[], direction: 1 | -1): string {
  const ids = ['', ...spaces.map(s => s.id)], i = ids.indexOf(activeSpace(active, spaces));
  return ids[(i + direction + ids.length) % ids.length];
}
