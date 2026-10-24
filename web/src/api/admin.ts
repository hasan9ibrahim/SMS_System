// Admin (§11, §12.5, §13.28): users, passwords and 2FA, departments, GUI access groups, logged-in
// users, e-mail templates, business companies and customer portal logins. Lists go through
// fetchListPage; these are the record reads and writes.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AccessCatalog,
  AccessGroupInput,
  AccessGroupSaved,
  BusinessCompanyInput,
  BusinessCompanyRecord,
  BusinessCompanySaved,
  CompanyFile,
  DepartmentInput,
  DepartmentSaved,
  EmailAsset,
  EmailAssetList,
  EmailAssetUpload,
  EmailPlaceholderCatalog,
  EmailTemplateTestInput,
  EmailTemplateTestResult,
  EmailTemplateInput,
  EmailTemplatePreview,
  EmailTemplatePreviewInput,
  EmailTemplateRecord,
  EmailTemplateSaved,
  ForcePasswordChangeResult,
  FilterGroup,
  FormatVariables,
  ListId,
  PasswordChangeInput,
  PasswordChanged,
  PasswordCodeSent,
  PasswordCheck,
  PasswordCheckInput,
  PortalUserInput,
  PortalUserSaved,
  SmtpCheckInput,
  SmtpCheckResult,
  TempPasswordInput,
  TotpSetup,
  UserInput,
  UserSaved,
} from "@sms/contract";
import { api, unwrap } from "./client";
import { fetchListPage } from "./hooks";
import { downloadFrom } from "./observation";
import { useRefreshRecords } from "./records";

function useWrite<In, Out>(fn: (input: In) => Promise<Out>) {
  const refresh = useRefreshRecords();
  return useMutation({ mutationFn: fn, onSuccess: () => void refresh() });
}
const path = (id: number) => ({ params: { path: { id } } });

/** Every live row of a short list (departments, access groups, templates), for form pickers. */
export function useAllRows<Row>(list: ListId, filter?: FilterGroup) {
  return useQuery({
    queryKey: ["list", "all", list, filter ?? null],
    queryFn: () => fetchListPage<Row>(list, { limit: 1000, withTotal: false, ...(filter ? { filter } : {}) }),
    select: (p) => p.rows,
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------- users and passwords

export const useSaveUser = () =>
  useWrite(({ id, input }: { id: number | null; input: UserInput }): Promise<UserSaved> =>
    id === null
      ? unwrap(api.POST("/users", { body: input }))
      : unwrap(api.PUT("/users/{id}", { ...path(id), body: input })),
  );
export const useSetUserPassword = () =>
  useWrite(({ id, input }: { id: number; input: TempPasswordInput }): Promise<UserSaved> =>
    unwrap(api.POST("/users/{id}/password", { ...path(id), body: input })),
  );
export const useForcePasswordChange = () =>
  useWrite((ids: number[]): Promise<ForcePasswordChangeResult> =>
    unwrap(api.POST("/users/force-password-change", { body: { ids } })),
  );
export const setupTotp = (id: number): Promise<TotpSetup> => unwrap(api.POST("/users/{id}/totp/setup", path(id)));
export const useConfirmTotp = () =>
  useWrite(({ id, code }: { id: number; code: string }): Promise<UserSaved> =>
    unwrap(api.POST("/users/{id}/totp/confirm", { ...path(id), body: { code } })),
  );
export const useDisableTotp = () =>
  useWrite((id: number): Promise<UserSaved> => unwrap(api.POST("/users/{id}/totp/disable", path(id))));
export const useChangeMyPassword = () =>
  useWrite((input: PasswordChangeInput): Promise<PasswordChanged> => unwrap(api.POST("/me/password", { body: input })));
/** E-mails a code for my password change when I have no authenticator app (R6, §13.28). */
export const sendMyPasswordCode = (): Promise<PasswordCodeSent> => unwrap(api.POST("/me/password/code"));

/** The §13.28 rules for a password being typed (debounced by the caller). */
export function usePasswordCheck(input: PasswordCheckInput | null) {
  return useQuery<PasswordCheck>({
    queryKey: ["password-check", input],
    queryFn: () => unwrap(api.POST("/password-check", { body: input! })),
    enabled: input !== null,
    placeholderData: (prev) => prev,
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------- departments and access groups

export const useSaveDepartment = () =>
  useWrite(({ id, input }: { id: number | null; input: DepartmentInput }): Promise<DepartmentSaved> =>
    id === null
      ? unwrap(api.POST("/departments", { body: input }))
      : unwrap(api.PUT("/departments/{id}", { ...path(id), body: input })),
  );
export const useSaveAccessGroup = () =>
  useWrite(({ id, input }: { id: number | null; input: AccessGroupInput }): Promise<AccessGroupSaved> =>
    id === null
      ? unwrap(api.POST("/access-groups", { body: input }))
      : unwrap(api.PUT("/access-groups/{id}", { ...path(id), body: input })),
  );
export const useCloneAccessGroup = () =>
  useWrite(({ id, name }: { id: number; name: string }): Promise<AccessGroupSaved> =>
    unwrap(api.POST("/access-groups/{id}/clone", { ...path(id), body: { name } })),
  );
export function useAccessCatalog() {
  return useQuery<AccessCatalog>({
    queryKey: ["access-catalog"],
    queryFn: () => unwrap(api.GET("/access-groups/catalog")),
    staleTime: Infinity,
  });
}

export const useEndSession = () => useWrite((id: number) => unwrap(api.POST("/user-sessions/{id}/end", path(id))));

// ---------------------------------------------------------------- e-mail templates

export function useEmailTemplate(id: number | null) {
  return useQuery<EmailTemplateRecord>({
    queryKey: ["record", "email-template", id],
    queryFn: () => unwrap(api.GET("/email-templates/{id}", path(id!))),
    enabled: id !== null,
  });
}
export const useSaveEmailTemplate = () =>
  useWrite(({ id, input }: { id: number | null; input: EmailTemplateInput }): Promise<EmailTemplateSaved> =>
    id === null
      ? unwrap(api.POST("/email-templates", { body: input }))
      : unwrap(api.PUT("/email-templates/{id}", { ...path(id), body: input })),
  );
export const useCloneEmailTemplate = () =>
  useWrite(({ id, name }: { id: number; name: string }): Promise<EmailTemplateSaved> =>
    unwrap(api.POST("/email-templates/{id}/clone", { ...path(id), body: { name } })),
  );
export function useEmailPlaceholders() {
  return useQuery<EmailPlaceholderCatalog>({
    queryKey: ["email-placeholders"],
    queryFn: () => unwrap(api.GET("/email-templates/placeholders")),
    staleTime: Infinity,
  });
}
export function useTemplatePreview(input: EmailTemplatePreviewInput | null) {
  return useQuery<EmailTemplatePreview>({
    queryKey: ["template-preview", input],
    queryFn: () => unwrap(api.POST("/email-templates/preview", { body: input! })),
    enabled: input !== null,
    placeholderData: (prev) => prev,
  });
}

/** Images for e-mail designs (§11): a company's own and the shared ones. */
export function useEmailAssets(businessCompanyId: number | null) {
  return useQuery<EmailAssetList>({
    queryKey: ["email-assets", businessCompanyId],
    queryFn: () =>
      unwrap(
        api.GET("/email-assets", {
          params: { query: businessCompanyId == null ? {} : { businessCompanyId } },
        }),
      ),
  });
}
export function useUploadEmailAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: EmailAssetUpload): Promise<EmailAsset> => unwrap(api.POST("/email-assets", { body: input })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["email-assets"] }),
  });
}
/** A test of a template to real addresses, to check it in Outlook (logged in Email Logs). */
export const useTestEmailTemplate = () =>
  useMutation({
    mutationFn: (input: EmailTemplateTestInput): Promise<EmailTemplateTestResult> =>
      unwrap(api.POST("/email-templates/test", { body: input })),
  });

// ---------------------------------------------------------------- business companies

export function useBusinessCompany(id: number | null) {
  return useQuery<BusinessCompanyRecord>({
    queryKey: ["record", "business-company", id],
    queryFn: () => unwrap(api.GET("/business-companies/{id}", path(id!))),
    enabled: id !== null,
  });
}
export const useSaveBusinessCompany = () =>
  useWrite(({ id, input }: { id: number | null; input: BusinessCompanyInput }): Promise<BusinessCompanySaved> =>
    id === null
      ? unwrap(api.POST("/business-companies", { body: input }))
      : unwrap(api.PUT("/business-companies/{id}", { ...path(id), body: input })),
  );
export const useCloneBusinessCompany = () =>
  useWrite(({ id, name }: { id: number; name: string }): Promise<BusinessCompanySaved> =>
    unwrap(api.POST("/business-companies/{id}/clone", { ...path(id), body: { name } })),
  );
export const useUploadCompanyFile = () =>
  useWrite(
    ({
      id,
      kind,
      name,
      contentBase64,
    }: {
      id: number;
      kind: CompanyFile["kind"];
      name: string;
      contentBase64: string;
    }) =>
      unwrap(
        api.PUT("/business-companies/{id}/files/{kind}", {
          params: { path: { id, kind } },
          body: { name, contentBase64 },
        }),
      ),
  );
export const downloadCompanyFile = (id: number, kind: CompanyFile["kind"], name: string) =>
  downloadFrom(`/business-companies/${id}/files/${kind}`, undefined, name);
export const checkSmtp = (input: SmtpCheckInput): Promise<SmtpCheckResult> =>
  unwrap(api.POST("/business-companies/check-smtp", { body: input }));
export function useFormatVariables() {
  return useQuery<FormatVariables>({
    queryKey: ["format-variables"],
    queryFn: () => unwrap(api.GET("/business-companies/format-variables")),
    staleTime: Infinity,
  });
}

// ---------------------------------------------------------------- customer portal users

export const useSavePortalUser = () =>
  useWrite(({ id, input }: { id: number | null; input: PortalUserInput }): Promise<PortalUserSaved> =>
    id === null
      ? unwrap(api.POST("/customer-portal-users", { body: input }))
      : unwrap(api.PUT("/customer-portal-users/{id}", { ...path(id), body: input })),
  );
export const useSetPortalPassword = () =>
  useWrite(({ id, input }: { id: number; input: TempPasswordInput }): Promise<PortalUserSaved> =>
    unwrap(api.POST("/customer-portal-users/{id}/password", { ...path(id), body: input })),
  );
