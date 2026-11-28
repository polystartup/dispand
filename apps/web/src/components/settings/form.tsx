import { createFormHook, createFormHookContexts } from "@tanstack/react-form";
import type { ComponentProps } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "./parts.tsx";

const { fieldContext, formContext, useFieldContext } = createFormHookContexts();

type TextFieldProps = { label: string; id: string; hint?: string; onBlur?: () => void } & (
  | ({ multiline?: false } & Omit<ComponentProps<typeof Input>, "id" | "value" | "onChange" | "onBlur">)
  | ({ multiline: true } & Omit<ComponentProps<typeof Textarea>, "id" | "value" | "onChange" | "onBlur">)
);

/** A text field of a form: its value, its blur and its first error go through `FormField`. */
function TextField({ label, id, hint, onBlur, multiline, ...control }: TextFieldProps) {
  const field = useFieldContext<string>();
  const shared = {
    id,
    value: field.state.value,
    onBlur: () => {
      field.handleBlur();
      onBlur?.();
    },
  };
  return (
    <FormField label={label} htmlFor={id} hint={hint} error={field.state.meta.errors.filter(Boolean).join(" ") || undefined}>
      {multiline ? (
        <Textarea {...shared} {...(control as ComponentProps<typeof Textarea>)} onChange={(e) => field.handleChange(e.target.value)} />
      ) : (
        <Input {...shared} {...(control as ComponentProps<typeof Input>)} onChange={(e) => field.handleChange(e.target.value)} />
      )}
    </FormField>
  );
}

/** `useForm` with `TextField` on every `AppField`. */
export const { useAppForm } = createFormHook({ fieldContext, formContext, fieldComponents: { TextField }, formComponents: {} });
