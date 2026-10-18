-- SPDX-License-Identifier: AGPL-3.0-or-later
-- More model formats (S5.08): an avatar or an item may be an FBX, an OBJ or a .blend (read by
-- headless Blender) or a DAE (read by assimp in the converter), as well as a VRM or a GLB. A file
-- that keeps no declaration of its own (an FBX, an OBJ, a DAE) is given one with its upload slot:
-- the item's name, slot and the regions it hides or the point it is worn at, as
-- packages/content's readItemDeclaration returns it. The converter uses it when the file declares
-- nothing.

alter table items add column declaration jsonb;
