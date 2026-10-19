// Migration Center (§13.22): entities and templates, column mappings, export packages with single-use
// download links, imports with dry run, apply, go-live and (through History undo) rollback.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  MigrationActivate,
  MigrationActivateResult,
  MigrationEntityInfo,
  MigrationExport,
  MigrationExportInput,
  MigrationImport,
  MigrationImportEntity,
  MigrationImportInput,
  MigrationLink,
  MigrationMapping,
  MigrationMappingInput,
} from "@sms/contract";
import { api, apiFetch, unwrap } from "./client";

const path = (id: number) => ({ params: { path: { id } } });

function useWrite<In, Out>(fn: (input: In) => Promise<Out>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["record", "migration"] });
      void qc.invalidateQueries({ queryKey: ["history"] });
    },
  });
}

export function useMigrationEntities() {
  return useQuery<MigrationEntityInfo[]>({
    queryKey: ["record", "migration", "entities"],
    queryFn: () => unwrap(api.GET("/migration/entities")),
    staleTime: Infinity,
  });
}
export function useMigrationMappings() {
  return useQuery<MigrationMapping[]>({
    queryKey: ["record", "migration", "mappings"],
    queryFn: () => unwrap(api.GET("/migration/mappings")),
  });
}
export function useMigrationExports() {
  return useQuery<MigrationExport[]>({
    queryKey: ["record", "migration", "exports"],
    queryFn: () => unwrap(api.GET("/migration/exports")),
    // A package is written in the background: refresh until none is running.
    refetchInterval: (q) => (q.state.data?.some((x) => x.status === "running") ? 2000 : false),
  });
}
export function useMigrationImports() {
  return useQuery<MigrationImport[]>({
    queryKey: ["record", "migration", "imports"],
    queryFn: () => unwrap(api.GET("/migration/imports")),
  });
}
export function useMigrationImport(id: number | null) {
  return useQuery<MigrationImport>({
    queryKey: ["record", "migration", "import", id],
    queryFn: () => unwrap(api.GET("/migration/imports/{id}", path(id!))),
    enabled: id !== null,
  });
}

export const useSaveMapping = () =>
  useWrite((body: MigrationMappingInput): Promise<MigrationMapping> =>
    unwrap(api.POST("/migration/mappings", { body })),
  );
export const useCreateExport = () =>
  useWrite((body: MigrationExportInput): Promise<MigrationExport> => unwrap(api.POST("/migration/exports", { body })));
export const useCreateLink = () =>
  useWrite(({ id, totpCode }: { id: number; totpCode: string | null }): Promise<MigrationLink> =>
    unwrap(api.POST("/migration/exports/{id}/link", { ...path(id), body: { totpCode } })),
  );
export const useCreateImport = () =>
  useWrite((body: MigrationImportInput): Promise<MigrationImport> => unwrap(api.POST("/migration/imports", { body })));
export const useRevalidateImport = () =>
  useWrite(({ id, body }: { id: number; body: MigrationImportInput }): Promise<MigrationImport> =>
    unwrap(api.PUT("/migration/imports/{id}", { ...path(id), body })),
  );
export const useApplyImport = () =>
  useWrite((id: number): Promise<MigrationImport> => unwrap(api.POST("/migration/imports/{id}/apply", path(id))));
export const useActivateTrunks = () =>
  useWrite(({ id, body }: { id: number; body: MigrationActivate }): Promise<MigrationActivateResult> =>
    unwrap(api.POST("/migration/imports/{id}/activate", { ...path(id), body })),
  );

async function saveResponse(res: Response, fallback: string) {
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallback;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** The import template of one entity (header + example row). */
export async function downloadTemplate(entity: MigrationImportEntity): Promise<void> {
  const res = await apiFetch(`/api/v1/migration/templates/${entity}`);
  if (!res.ok) throw new Error(`Template download failed (${res.status})`);
  await saveResponse(res, `import_${entity}.csv`);
}

/** Uses a single-use link: the second request answers 410. */
export async function downloadPackage(url: string): Promise<void> {
  const res = await apiFetch(url);
  if (res.status === 410) throw new Error("This link was used or has expired: make a new one");
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  await saveResponse(res, "migration-export.smspkg");
}
