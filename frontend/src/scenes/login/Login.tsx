import { H4 } from '../../components/H4'
import React from 'react'
import { Box } from '../../components/Box'
import { Form } from 'kea-forms'
import { Field } from '../../components/Field'
import { TextInput } from '../../components/TextInput'
import { Button } from '../../components/Button'
import { loginForm } from './loginForm'
import { useValues } from 'kea'

export function Login() {
  const { isLoginFormSubmitting } = useValues(loginForm)
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
      <Box id="add-frame" className="p-4 mb-12 w-80 max-w-full">
        <Form logic={loginForm} formKey="loginForm" className="space-y-4" enableFormOnSubmit>
          <Field name="email" label="E-mail">
            <TextInput name="email" placeholder="email" required />
          </Field>
          <Field name="password" label="Password">
            <TextInput name="password" placeholder="" type="password" required />
          </Field>
          <div className="flex gap-2">
            <Button disabled={isLoginFormSubmitting} type="submit" className="w-full bg-[#5B5983] hover:bg-[#7A6D86]">
              Login
            </Button>
          </div>
        </Form>
      </Box>
    </div>
  )
}

export default Login
