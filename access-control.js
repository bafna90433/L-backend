const { prisma } = require('./postgres-models');

const PERMISSION_GROUPS = [
  { group: 'Dashboard', permissions: [{ key: 'dashboard.view', label: 'View dashboard' }] },
  { group: 'Labour', permissions: [
    { key: 'labours.view', label: 'View labourers' },
    { key: 'labours.manage', label: 'Add and edit labourers' }
  ] },
  { group: 'Attendance', permissions: [
    { key: 'attendance.view', label: 'View attendance' },
    { key: 'attendance.manage', label: 'Mark and edit attendance' }
  ] },
  { group: 'Cash & expenses', permissions: [
    { key: 'expenses.view', label: 'View transactions and balance' },
    { key: 'expenses.create', label: 'Log expenses and cash received' },
    { key: 'expenses.manage', label: 'Edit and remove transactions' }
  ] },
  { group: 'Advances', permissions: [
    { key: 'advances.view', label: 'View advance requests' },
    { key: 'advances.create', label: 'Create advance requests' },
    { key: 'advances.approve', label: 'Approve or reject advances' }
  ] },
  { group: 'Work', permissions: [
    { key: 'reminders.view', label: 'View and acknowledge reminders' },
    { key: 'reminders.manage', label: 'Create and edit reminders' },
    { key: 'tasks.view', label: 'View tasks' },
    { key: 'tasks.manage', label: 'Create and update tasks' },
    { key: 'chat.use', label: 'Use team chat' }
  ] },
  { group: 'Management', permissions: [
    { key: 'salary.view', label: 'View salary' },
    { key: 'settings.manage', label: 'Manage system settings' },
    { key: 'staff.view', label: 'View staff directory' },
    { key: 'staff.manage', label: 'Add and edit staff' },
    { key: 'roles.manage', label: 'Create and edit roles' }
  ] }
];

const DEFAULT_STAFF_PERMISSIONS = [
  'dashboard.view', 'labours.view', 'labours.manage', 'expenses.view', 'expenses.create', 'expenses.manage',
  'advances.view', 'advances.create', 'reminders.view', 'tasks.view',
  'tasks.manage', 'chat.use', 'staff.view'
];

const DEFAULT_ROLES = [
  { name: 'MD / Owner', slug: 'owner', description: 'Full system control', permissions: ['*'], isSystem: true },
  { name: 'Office Staff', slug: 'staff', description: 'Standard office operations', permissions: DEFAULT_STAFF_PERMISSIONS, isSystem: true },
  { name: 'Office Staff 2', slug: 'staff2', description: 'Existing second staff access', permissions: DEFAULT_STAFF_PERMISSIONS, isSystem: true }
];

const providerIsPostgres = () => (process.env.DATABASE_PROVIDER || 'mongodb').toLowerCase() === 'postgresql';

async function ensureDefaultRoles() {
  if (!providerIsPostgres()) return;
  for (const role of DEFAULT_ROLES) {
    await prisma.role.upsert({
      where: { slug: role.slug },
      update: { name: role.name, description: role.description, isSystem: true },
      create: { ...role, isActive: true }
    });
  }
  const roles = await prisma.role.findMany({ where: { slug: { in: DEFAULT_ROLES.map(role => role.slug) } } });
  for (const role of roles) {
    await prisma.user.updateMany({
      where: { role: role.slug, roleId: null },
      data: { roleId: role.id }
    });
  }
}

async function resolveUserAccess(user) {
  const legacyRole = user?.role || 'staff';
  if (legacyRole === 'owner') return { roleName: 'MD / Owner', roleId: user?.roleId || null, permissions: ['*'], isActive: user?.isActive !== false };
  if (!providerIsPostgres()) {
    return { roleName: legacyRole === 'staff2' ? 'Office Staff 2' : 'Office Staff', roleId: null, permissions: DEFAULT_STAFF_PERMISSIONS, isActive: true };
  }
  const role = user?.roleId
    ? await prisma.role.findUnique({ where: { id: user.roleId } })
    : await prisma.role.findUnique({ where: { slug: legacyRole } });
  return {
    roleName: role?.name || legacyRole,
    roleId: role?.id || user?.roleId || null,
    permissions: role?.isActive === false ? [] : (role?.permissions || []),
    isActive: user?.isActive !== false && role?.isActive !== false
  };
}

const hasPermission = (user, permission) => {
  const permissions = user?.permissions || [];
  return user?.role === 'owner' || permissions.includes('*') || permissions.includes(permission);
};

const permissionMiddleware = permission => (req, res, next) => {
  if (!hasPermission(req.user, permission)) {
    return res.status(403).json({ message: `Access denied: ${permission} permission required` });
  }
  next();
};

module.exports = {
  PERMISSION_GROUPS,
  DEFAULT_ROLES,
  ensureDefaultRoles,
  resolveUserAccess,
  hasPermission,
  permissionMiddleware
};
