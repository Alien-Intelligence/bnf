# Forms Rule

## Rule

Every form uses **react-hook-form** with a **Zod schema** and the shadcn `Form`
component system. No form may use uncontrolled inputs, manual `useState`
per field, or ad-hoc validation logic.

## Setup (one-time)

```bash
npx shadcn@latest add form
```

Installs `Form`, `FormField`, `FormItem`, `FormLabel`, `FormControl`,
`FormDescription`, `FormMessage`.

## File structure

```
components/forms/<feature>/<name>.tsx
```

| File path | Export |
|---|---|
| `components/forms/projects/create.tsx` | `FormProjectCreate` |
| `components/forms/memory/item-edit.tsx` | `FormMemoryItemEdit` |
| `components/forms/notes/edit.tsx` | `FormNoteEdit` |
| `components/forms/corpus/filter.tsx` | `FormCorpusFilter` |

## Schema source

The same Zod schema validates the form on the client and the request body on
the server. The schema is defined once in `models/<model>/types.ts` (see
[models.md](models.md)) and imported by both the form and the route handler.

```ts
// models/projects/types.ts
import { z } from "zod"

export const createProjectSchema = z.object({
  name: z.string().trim().min(1, "Le nom est requis").max(120),
  subtitle: z.string().trim().max(200).optional(),
})
export type CreateProjectInput = z.infer<typeof createProjectSchema>
```

## Required structure

```tsx
// components/forms/projects/create.tsx
"use client"

import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useTranslations } from "next-intl"
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage }
  from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { createProjectSchema, type CreateProjectInput } from "@/models/projects/types"

type FormProjectCreateProps = {
  onSubmit: (data: CreateProjectInput) => Promise<void>
  defaultValues?: Partial<CreateProjectInput>
}

export function FormProjectCreate({ onSubmit, defaultValues }: FormProjectCreateProps) {
  const t = useTranslations("projects.form")
  const form = useForm<CreateProjectInput>({
    resolver: zodResolver(createProjectSchema),
    defaultValues: { name: "", subtitle: "", ...defaultValues },
  })

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("nameLabel")}</FormLabel>
              <FormControl>
                <Input placeholder={t("namePlaceholder")} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="subtitle"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("subtitleLabel")}</FormLabel>
              <FormControl>
                <Input placeholder={t("subtitlePlaceholder")} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? t("creating") : t("create")}
        </Button>
      </form>
    </Form>
  )
}
```

## Rules

### Schema
- **Always** import the schema from `models/<model>/types.ts` — the form must
  not redefine validation rules. The route handler shares the same schema.
- **Always** use `z.infer<typeof schema>` for the data type — never write it by hand.
- **Always** put error messages in the schema, never in render logic. Use
  i18n keys for the message strings via `z.string().min(1, t("required"))`
  when the schema is invoked from a client (see [i18n.md](i18n.md)).

### Form state
- **Use** `form.formState.isSubmitting` for loading state — never add a separate
  `useState<boolean>`.
- **Use** `form.reset()` to clear the form after a successful submission.
- **Never** duplicate validation in `handleSubmit` — the schema handles it.

### Fields
- **Every** field is wrapped in `FormField` → `FormItem` → `FormLabel` +
  `FormControl` + `FormMessage`.
- **Never** use a raw `<input>` — always spread `{...field}` from `FormField`'s
  render prop.
- `FormMessage` automatically renders the Zod validation error — do **not** add
  manual error display alongside it.

### Props
- The form receives `onSubmit: (data: T) => Promise<void>`. It does **not** call
  APIs directly.
- The caller (the dialog or page that hosts the form) calls the mutation hook,
  shows the toast, and closes the dialog (see below).

## Where forms live

A form component is always rendered inside a named dialog, sheet, or page:

```tsx
// components/dialogs/projects/create.tsx
"use client"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { FormProjectCreate } from "@/components/forms/projects/create"
import { useCreateProject } from "@/hooks/api/projects"
import { toast } from "sonner"

export function DialogProjectCreate({ open, onOpenChange }: Props) {
  const t = useTranslations("projects.dialogCreate")
  const createProject = useCreateProject()

  const handleSubmit = async (data: CreateProjectInput) => {
    await createProject.mutateAsync(data)
    toast.success(t("created"))
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t("title")}</DialogTitle></DialogHeader>
        <FormProjectCreate onSubmit={handleSubmit} />
      </DialogContent>
    </Dialog>
  )
}
```

The form has no knowledge of the dialog. The dialog has no knowledge of the
form's internals.

## Anti-patterns (FORBIDDEN)

```tsx
// ❌ Manual state per field
const [name, setName] = useState("")

// ❌ Manual validation in handleSubmit
if (!name) { setError("Name required"); return }

// ❌ Separate loading state
const [loading, setLoading] = useState(false)

// ❌ Schema defined inside the form file (it belongs in models/<model>/types.ts)
const schema = z.object({ name: z.string() })

// ❌ Uncontrolled input without FormField
<input value={name} onChange={e => setName(e.target.value)} />

// ❌ Form calling the API directly
const handleSubmit = async (data) => {
  await fetch("/api/projects", { method: "POST", body: JSON.stringify(data) })
}
```

## Special case — corpus filter & search inputs

The **filter / search input** on the Constituer page is *not* a form in the
form-submit sense — it filters the visible document list locally as the user
types. It is implemented as a controlled input bound to a URL search param (or
a `useState` in the page client), not via `FormProjectFilter`. See
[client-patterns.md](client-patterns.md) for the URL-as-state pattern.

The `FormCorpusFilter` exists for the **memory dialog's filter saving** action
(persisting a named filter set into project memory) — that *is* a form submit.
