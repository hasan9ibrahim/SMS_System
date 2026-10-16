// Single import point for contract types, shared by web/ and mock/.
// Everything under generated/ is produced by `npm run gen`; do not edit it by hand.
export type { paths, components, operations } from "./generated/openapi.js";
export type * from "./generated/events.js";

import type { components } from "./generated/openapi.js";

type Schemas = components["schemas"];

export type Problem = Schemas["Problem"];
export type Health = Schemas["Health"];
export type CurrentUser = Schemas["CurrentUser"];
export type ListId = Schemas["ListId"];
export type ListQuery = Schemas["ListQuery"];
export type ListFields = Schemas["ListFields"];
export type FieldDescriptor = Schemas["FieldDescriptor"];
export type FilterGroup = Schemas["FilterGroup"];
export type FilterCondition = Schemas["FilterCondition"];
export type FilterOperator = Schemas["FilterOperator"];
export type SortKey = Schemas["SortKey"];
export type ListPageMeta = Schemas["ListPageMeta"];
export type Enterprise = Schemas["Enterprise"];
export type EnterprisePage = Schemas["EnterprisePage"];
export type PreferencesUpdate = Schemas["PreferencesUpdate"];
export type Workspace = Schemas["Workspace"];
export type WorkspaceTab = Schemas["WorkspaceTab"];
export type SearchHit = Schemas["SearchHit"];
export type SearchResults = Schemas["SearchResults"];
export type FieldType = Schemas["FieldType"];
export type UserSummary = Schemas["UserSummary"];
export type UserPage = Schemas["UserPage"];
export type ViewState = Schemas["ViewState"];
export type SavedView = Schemas["SavedView"];
export type SavedViewInput = Schemas["SavedViewInput"];
export type Change = Schemas["Change"];
export type ChangeField = Schemas["ChangeField"];
export type ChangePage = Schemas["ChangePage"];
export type UndoRequest = Schemas["UndoRequest"];
export type UndoConflict = Schemas["UndoConflict"];
export type Theme = Schemas["Theme"];
export type FilterValue = Schemas["FilterValue"];
