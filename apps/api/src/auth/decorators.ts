import { SetMetadata } from '@nestjs/common';
import type { Role } from '@helpdesk/shared';

export const IS_PUBLIC = 'isPublic';
export const ROLES_KEY = 'roles';

/** Route needs no session. EVERY other route requires one — the guard is global (deny by default). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Route is limited to these roles (checked on the server, after authentication). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
