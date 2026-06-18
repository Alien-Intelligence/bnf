import { z } from "zod"

// Sign-in and sign-up schemas are used client-side (react-hook-form + Zod)
// to validate form input before POSTing to better-auth's handler endpoints.
// Better-auth owns the server-side validation for those routes.

export const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
})
export type SignInInput = z.infer<typeof signInSchema>

export const signUpSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
})
export type SignUpInput = z.infer<typeof signUpSchema>
