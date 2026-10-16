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
