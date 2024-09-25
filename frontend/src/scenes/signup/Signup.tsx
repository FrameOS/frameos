// src/scenes/signup/Signup.tsx

import { H4 } from '../../components/H4'
import React from 'react'
import { Box } from '../../components/Box'
import { Form } from 'kea-forms'
import { Field } from '../../components/Field'
import { TextInput } from '../../components/TextInput'
import { Button } from '../../components/Button'
import { signupLogic } from './signupLogic'
import { useValues } from 'kea'
import { Label } from '../../components/Label'

export function Signup() {
  const { isSignupFormSubmitting } = useValues(signupLogic)
  return (
    <div className="h-full w-full min-h-screen max-w-screen flex flex-col items-center justify-center gap-8">
      <div className="flex gap-4 justify-center items-center">
        <img
          src="/img/logo/dark-mark-small.png"
          className="w-[48px] h-[48px] inline-block align-center"
          alt="FrameOS"
        />
        <H4 className="tracking-wide text-[2.9rem]">FrameOS</H4>
      </div>
      <Box id="signup" className="p-4 mb-12 w-80 max-w-full">
        <Form logic={signupLogic} formKey="signupForm" className="space-y-4" enableFormOnSubmit>
          <Field name="email" label="Email">
            <TextInput name="email" placeholder="email@example.com" autoComplete="email" type="email" required />
          </Field>
          <Field name="password" label="Password">
            <TextInput name="password" placeholder="" type="password" required autoComplete="new-password" />
          </Field>
          <Field name="password2" label="Confirm Password">
            <TextInput name="password2" placeholder="" type="password" required autoComplete="new-password" />
          </Field>
          <Field name="newsletter">
            {({ value, onChange }) => (
              <Label>
                <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
                <span>Sign up to the newsletter</span>
              </Label>
            )}
          </Field>
          <div className="flex gap-2">
            <Button disabled={isSignupFormSubmitting} type="submit" className="w-full bg-[#5B5983] hover:bg-[#7A6D86]">
              Sign Up
            </Button>
          </div>
        </Form>
      </Box>
    </div>
  )
}

export default Signup
