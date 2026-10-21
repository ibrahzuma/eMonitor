import { useQuery } from "@tanstack/react-query";
import { FolderTree, Pencil, Plus, Trash2, UserPlus } from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { groupsApi, teamsApi, usersApi } from "@/api/endpoints";
import { qk } from "@/api/queryKeys";
import { PageHeader, Pagination, RelativeTime } from "@/components/common";
import { GroupSelect, MemberPicker, useGroups, useMembers, useTeams } from "@/components/pickers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/controls";
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { EmptyState, ErrorState, InlineError, LoadingState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useAuth, useCan } from "@/features/auth/AuthProvider";
import { fieldErrorsOf, useApiMutation, useDebounced } from "@/hooks/useApi";
import { type AssignableRole, type Group, type Member, ROLES, type Team } from "@/types/api";
import { humanize } from "@/utils/format";

const PAGE_SIZE = 50;

// ---------------------------------------------------------------- members

function AddUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState<AssignableRole>("viewer");
  const [password, setPassword] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<unknown>(null);

  React.useEffect(() => {
    if (open) {
      setEmail("");
      setName("");
      setRole("viewer");
      setPassword("");
      setErrors({});
      setFormError(null);
    }
  }, [open]);

  const create = useApiMutation({
    mutationFn: () => usersApi.create({ email: email.trim(), full_name: name.trim(), role, password: password || null }),
    invalidate: [qk.users],
    success: (m) => `${m.email} added to the organization`,
    errorTitle: false,
    onSuccess: () => onOpenChange(false),
    onError: (e) => {
      setErrors(fieldErrorsOf(e));
      setFormError(e);
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!email.trim()) fe.email = "Email is required";
    else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) fe.email = "Enter a valid email address";
    if (password && password.length < 12) fe.password = "Use at least 12 characters";
    setErrors(fe);
    setFormError(null);
    if (Object.keys(fe).length) return;
    create.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
          <DialogDescription>Add an existing account or create a new one in this organization.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="contents" noValidate>
          <DialogBody className="flex flex-col gap-3">
            {formError !== null && <InlineError error={formError} />}
            <Field label="Email" htmlFor="add-user-email" error={errors.email} required>
              <Input id="add-user-email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Full name" htmlFor="add-user-name" error={errors.full_name}>
              <Input id="add-user-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
            </Field>
            <Field label="Role" htmlFor="add-user-role" error={errors.role}>
              <NativeSelect id="add-user-role" value={role} onChange={(e) => setRole(e.target.value as AssignableRole)}>
                {ROLES.map((r) => <option key={r} value={r}>{humanize(r)}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Initial password" htmlFor="add-user-password" error={errors.password}
              hint="Required only when the email does not belong to an existing account (min. 12 characters).">
              <Input id="add-user-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={create.isPending}>Add user</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MembersTab() {
  const { user } = useAuth();
  const canManage = useCan("users:manage");
  const [q, setQ] = React.useState("");
  const dq = useDebounced(q.trim(), 300);
  const [page, setPage] = React.useState(1);
  const [adding, setAdding] = React.useState(false);
  const [removing, setRemoving] = React.useState<Member | null>(null);
  React.useEffect(() => setPage(1), [dq]);

  const params = { q: dq, page, page_size: PAGE_SIZE };
  const list = useQuery({ queryKey: qk.userList(params), queryFn: () => usersApi.list(params) });

  const update = useApiMutation({
    mutationFn: (v: { id: string; body: { role?: AssignableRole; is_active?: boolean } }) => usersApi.update(v.id, v.body),
    invalidate: [qk.users],
    success: (m, v) => (v.body.role ? `Role of ${m.email} changed to ${humanize(m.role)}` : m.is_active ? `${m.email} reactivated` : `${m.email} deactivated`),
    errorTitle: "Could not update user",
  });
  const remove = useApiMutation({
    mutationFn: (id: string) => usersApi.remove(id),
    invalidate: [qk.users],
    success: (m) => m.message,
    errorTitle: "Could not remove user",
    onSuccess: () => setRemoving(null),
  });

  return (
    <Card>
      <CardHeader className="flex-wrap">
        <Input type="search" aria-label="Search members" placeholder="Search by name or email…" value={q}
          onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        {canManage && <Button size="sm" onClick={() => setAdding(true)}><UserPlus /> Add user</Button>}
      </CardHeader>
      {list.isLoading ? <LoadingState /> : list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : !list.data?.items.length ? (
        <EmptyState title={dq ? "No members match your search" : "No members"} />
      ) : (
        <>
          <Table>
            <THead>
              <TR><TH>User</TH><TH>Role</TH><TH>Status</TH><TH>2FA</TH><TH>Last login</TH><TH>Joined</TH>{canManage && <TH className="text-right">Actions</TH>}</TR>
            </THead>
            <TBody>
              {list.data.items.map((m) => {
                const self = m.user_id === user?.id;
                const assignable = (ROLES as readonly string[]).includes(m.role);
                return (
                  <TR key={m.user_id}>
                    <TD>
                      <div className="flex flex-col">
                        <span className="font-medium">{m.full_name || m.email}{self && <Badge variant="outline" className="ml-2">you</Badge>}</span>
                        {m.full_name && <span className="text-xs text-muted-foreground">{m.email}</span>}
                      </div>
                    </TD>
                    <TD>
                      {canManage && assignable ? (
                        <NativeSelect aria-label={`Role of ${m.email}`} value={m.role} className="h-7 w-36 text-xs"
                          disabled={update.isPending}
                          onChange={(e) => update.mutate({ id: m.user_id, body: { role: e.target.value as AssignableRole } })}>
                          {ROLES.map((r) => <option key={r} value={r}>{humanize(r)}</option>)}
                        </NativeSelect>
                      ) : <span className="text-sm">{humanize(m.role)}</span>}
                    </TD>
                    <TD>{m.is_active ? <Badge variant="success">Active</Badge> : <Badge variant="outline">Deactivated</Badge>}</TD>
                    <TD>{m.totp_enabled ? <Badge variant="success">Enabled</Badge> : <span className="text-xs text-muted-foreground">Off</span>}</TD>
                    <TD><RelativeTime value={m.last_login_at} /></TD>
                    <TD><RelativeTime value={m.created_at} /></TD>
                    {canManage && (
                      <TD className="text-right">
                        {!self && (
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="sm" onClick={() => update.mutate({ id: m.user_id, body: { is_active: !m.is_active } })}>
                              {m.is_active ? "Deactivate" : "Reactivate"}
                            </Button>
                            <Button variant="ghost" size="icon-sm" aria-label={`Remove ${m.email}`} onClick={() => setRemoving(m)}>
                              <Trash2 className="text-destructive" />
                            </Button>
                          </div>
                        )}
                      </TD>
                    )}
                  </TR>
                );
              })}
            </TBody>
          </Table>
          <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />
        </>
      )}
      <AddUserDialog open={adding} onOpenChange={setAdding} />
      <ConfirmDialog open={Boolean(removing)} onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.email ?? ""}?`} description="The user loses access to this organization. Their account remains for other organizations."
        destructive confirmLabel="Remove" loading={remove.isPending} onConfirm={() => removing && remove.mutate(removing.user_id)} />
    </Card>
  );
}

// ---------------------------------------------------------------- teams

function TeamDialog({ open, onOpenChange, team }: { open: boolean; onOpenChange: (o: boolean) => void; team: Team | null }) {
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [members, setMembers] = React.useState<string[]>([]);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (open) {
      setName(team?.name ?? "");
      setDescription(team?.description ?? "");
      setMembers(team?.member_ids ?? []);
      setErrors({});
    }
  }, [open, team]);
  const save = useApiMutation({
    mutationFn: () => {
      const body = { name: name.trim(), description, member_ids: members };
      return team ? teamsApi.update(team.id, body) : teamsApi.create(body);
    },
    invalidate: [qk.teams],
    success: team ? "Team updated" : "Team created",
    errorTitle: "Could not save team",
    onSuccess: () => onOpenChange(false),
    onError: (e) => setErrors(fieldErrorsOf(e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>{team ? `Edit team “${team.name}”` : "New team"}</DialogTitle></DialogHeader>
        <form className="contents" noValidate onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) {
            setErrors({ name: "Name is required" });
            return;
          }
          save.mutate();
        }}>
          <DialogBody className="flex flex-col gap-3">
            <Field label="Name" htmlFor="team-name" error={errors.name} required>
              <Input id="team-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            </Field>
            <Field label="Description" htmlFor="team-desc" error={errors.description}>
              <Textarea id="team-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
            </Field>
            <div className="flex flex-col gap-1">
              <label htmlFor="team-members" className="text-xs font-medium">Members</label>
              <MemberPicker id="team-members" value={members} onChange={setMembers} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={save.isPending}>{team ? "Save" : "Create team"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TeamsTab() {
  const canManage = useCan("users:manage");
  const teams = useTeams();
  const members = useMembers();
  const [editing, setEditing] = React.useState<Team | null>(null);
  const [open, setOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState<Team | null>(null);
  const names = new Map((members.data?.items ?? []).map((m) => [m.user_id, m.full_name || m.email] as const));
  const remove = useApiMutation({
    mutationFn: (id: string) => teamsApi.remove(id),
    invalidate: [qk.teams],
    success: "Team deleted",
    onSuccess: () => setDeleting(null),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Teams</CardTitle>
        {canManage && <Button size="sm" onClick={() => { setEditing(null); setOpen(true); }}><Plus /> New team</Button>}
      </CardHeader>
      {teams.isLoading ? <LoadingState /> : teams.isError ? <ErrorState error={teams.error} onRetry={() => void teams.refetch()} /> : !teams.data?.length ? (
        <EmptyState title="No teams yet" description="Teams route notifications and own resources." />
      ) : (
        <Table>
          <THead><TR><TH>Team</TH><TH>Members</TH><TH>Created</TH>{canManage && <TH className="text-right">Actions</TH>}</TR></THead>
          <TBody>
            {teams.data.map((t) => (
              <TR key={t.id}>
                <TD>
                  <div className="font-medium">{t.name}</div>
                  {t.description && <div className="text-xs text-muted-foreground">{t.description}</div>}
                </TD>
                <TD className="max-w-md">
                  <span className="tabular mr-2 text-xs text-muted-foreground">{t.member_ids.length}</span>
                  <span className="text-xs">{t.member_ids.map((id) => names.get(id) ?? id.slice(0, 8)).join(", ")}</span>
                </TD>
                <TD><RelativeTime value={t.created_at} /></TD>
                {canManage && (
                  <TD className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" aria-label={`Edit ${t.name}`} onClick={() => { setEditing(t); setOpen(true); }}><Pencil /></Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Delete ${t.name}`} onClick={() => setDeleting(t)}><Trash2 className="text-destructive" /></Button>
                    </div>
                  </TD>
                )}
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <TeamDialog open={open} onOpenChange={setOpen} team={editing} />
      <ConfirmDialog open={Boolean(deleting)} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete team “${deleting?.name ?? ""}”?`}
        destructive confirmLabel="Delete" loading={remove.isPending} onConfirm={() => deleting && remove.mutate(deleting.id)} />
    </Card>
  );
}

// ---------------------------------------------------------------- groups

function GroupDialog({ open, onOpenChange, group }: { open: boolean; onOpenChange: (o: boolean) => void; group: Group | null }) {
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [parent, setParent] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (open) {
      setName(group?.name ?? "");
      setDescription(group?.description ?? "");
      setParent(group?.parent_id ?? "");
      setErrors({});
    }
  }, [open, group]);
  const save = useApiMutation({
    mutationFn: () => {
      const body = { name: name.trim(), description, parent_id: parent || null };
      return group ? groupsApi.update(group.id, body) : groupsApi.create(body);
    },
    invalidate: [qk.groups],
    success: group ? "Group updated" : "Group created",
    errorTitle: "Could not save group",
    onSuccess: () => onOpenChange(false),
    onError: (e) => setErrors(fieldErrorsOf(e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>{group ? `Edit group “${group.name}”` : "New resource group"}</DialogTitle></DialogHeader>
        <form className="contents" noValidate onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) {
            setErrors({ name: "Name is required" });
            return;
          }
          save.mutate();
        }}>
          <DialogBody className="flex flex-col gap-3">
            <Field label="Name" htmlFor="group-name" error={errors.name} required>
              <Input id="group-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            </Field>
            <Field label="Description" htmlFor="group-desc" error={errors.description}>
              <Textarea id="group-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
            </Field>
            <Field label="Parent group" htmlFor="group-parent" error={errors.parent_id}>
              <GroupSelect id="group-parent" value={parent} onChange={setParent} emptyLabel="— Top level —" exclude={group?.id} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={save.isPending}>{group ? "Save" : "Create group"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function flattenTree(groups: Group[]): { group: Group; depth: number }[] {
  const ids = new Set(groups.map((g) => g.id));
  const children = new Map<string | null, Group[]>();
  for (const g of groups) {
    const key = g.parent_id && ids.has(g.parent_id) ? g.parent_id : null;
    children.set(key, [...(children.get(key) ?? []), g]);
  }
  const out: { group: Group; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const g of (children.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      out.push({ group: g, depth });
      walk(g.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function GroupsTab() {
  const canWrite = useCan("resources:write");
  const groups = useGroups();
  const [editing, setEditing] = React.useState<Group | null>(null);
  const [open, setOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState<Group | null>(null);
  const remove = useApiMutation({
    mutationFn: (id: string) => groupsApi.remove(id),
    invalidate: [qk.groups, qk.resources],
    success: (m) => m.message,
    onSuccess: () => setDeleting(null),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Resource groups</CardTitle>
        {canWrite && <Button size="sm" onClick={() => { setEditing(null); setOpen(true); }}><Plus /> New group</Button>}
      </CardHeader>
      {groups.isLoading ? <LoadingState /> : groups.isError ? <ErrorState error={groups.error} onRetry={() => void groups.refetch()} /> : !groups.data?.length ? (
        <EmptyState icon={<FolderTree aria-hidden />} title="No resource groups" description="Groups organize resources hierarchically and scope alert rules, maintenance and reports." />
      ) : (
        <Table>
          <THead><TR><TH>Group</TH><TH>Resources</TH><TH>Created</TH><TH className="text-right">Actions</TH></TR></THead>
          <TBody>
            {flattenTree(groups.data).map(({ group: g, depth }) => (
              <TR key={g.id}>
                <TD>
                  <div style={{ paddingLeft: depth * 18 }} className="flex flex-col">
                    <span className="font-medium">{depth > 0 && <span className="mr-1 text-muted-foreground" aria-hidden>└</span>}{g.name}</span>
                    {g.description && <span className="text-xs text-muted-foreground">{g.description}</span>}
                  </div>
                </TD>
                <TD className="tabular">{g.resource_count}</TD>
                <TD><RelativeTime value={g.created_at} /></TD>
                <TD className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button asChild variant="ghost" size="sm"><Link to={`/inventory?group_id=${g.id}`}>View resources</Link></Button>
                    {canWrite && (
                      <>
                        <Button variant="ghost" size="icon-sm" aria-label={`Edit ${g.name}`} onClick={() => { setEditing(g); setOpen(true); }}><Pencil /></Button>
                        <Button variant="ghost" size="icon-sm" aria-label={`Delete ${g.name}`} onClick={() => setDeleting(g)}><Trash2 className="text-destructive" /></Button>
                      </>
                    )}
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <GroupDialog open={open} onOpenChange={setOpen} group={editing} />
      <ConfirmDialog open={Boolean(deleting)} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete group “${deleting?.name ?? ""}”?`}
        description="Resources in this group become ungrouped." destructive confirmLabel="Delete" loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)} />
    </Card>
  );
}

// ---------------------------------------------------------------- page

const TABS = ["members", "teams", "groups"] as const;
type Tab = (typeof TABS)[number];

export function UsersPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? "") ? (raw as Tab) : "members";
  return (
    <div>
      <PageHeader title="Users & Teams" description="Organization members, roles, teams and resource groups." />
      <Tabs value={tab} onValueChange={(v) => setParams((p) => { const n = new URLSearchParams(p); n.set("tab", v); return n; }, { replace: true })}>
        <TabsList>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="teams">Teams</TabsTrigger>
          <TabsTrigger value="groups">Resource groups</TabsTrigger>
        </TabsList>
        <TabsContent value="members"><MembersTab /></TabsContent>
        <TabsContent value="teams"><TeamsTab /></TabsContent>
        <TabsContent value="groups"><GroupsTab /></TabsContent>
      </Tabs>
    </div>
  );
}
