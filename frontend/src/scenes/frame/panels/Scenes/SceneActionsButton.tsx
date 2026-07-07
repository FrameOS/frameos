import { useActions, useValues } from 'kea'
import clsx from 'clsx'
import { CheckIcon, ChevronDownIcon } from '@heroicons/react/24/outline'

import { Button, ButtonProps } from '../../../../components/Button'
import { DropdownMenu } from '../../../../components/DropdownMenu'
import { SceneActionKey, sceneActionsLogic } from './sceneActionsLogic'

export interface SceneActionOption {
  key: SceneActionKey
  label: string
  description?: string
  icon?: JSX.Element
  disabled?: boolean
  title?: string
  onRun: () => void
}

interface SceneActionsButtonProps {
  options: SceneActionOption[]
  /** Fallback selection until the user picks one from the dropdown. */
  defaultKey: SceneActionKey
  size?: ButtonProps['size']
  className?: string
}

/**
 * The standard scene action control: a main button that runs the selected
 * action, plus a dropdown listing every available action. Picking an option
 * runs it immediately and becomes the button's (globally remembered) default.
 */
export function SceneActionsButton({ options, defaultKey, size, className }: SceneActionsButtonProps): JSX.Element {
  const { preferredSceneAction } = useValues(sceneActionsLogic)
  const { setPreferredSceneAction } = useActions(sceneActionsLogic)

  const selected =
    options.find((option) => option.key === preferredSceneAction) ??
    options.find((option) => option.key === defaultKey) ??
    options[0]

  return (
    <div className={clsx('inline-flex items-stretch', className)}>
      <Button
        size={size}
        color="primary"
        className="flex items-center gap-2 !rounded-r-none"
        onClick={selected.onRun}
        disabled={selected.disabled}
        title={selected.title}
      >
        {selected.icon}
        {selected.label}
      </Button>
      <DropdownMenu
        buttonColor="primary"
        className="!rounded-l-none border-l border-white/30 !px-1"
        buttonTitle="Choose what this button does"
        buttonContent={<ChevronDownIcon className="h-4 w-4 self-center" aria-label="Choose action" />}
        items={options.map((option) => ({
          icon: option.icon,
          label: (
            <span className="flex min-w-0 flex-col">
              <span className="flex items-center gap-2 font-medium">
                {option.label}
                {option.key === selected.key ? <CheckIcon className="h-4 w-4 shrink-0" /> : null}
              </span>
              {option.description ? <span className="text-xs opacity-70">{option.description}</span> : null}
            </span>
          ),
          title: option.title,
          disabled: option.disabled,
          onClick: () => {
            setPreferredSceneAction(option.key)
            option.onRun()
          },
        }))}
      />
    </div>
  )
}
