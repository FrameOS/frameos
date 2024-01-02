## 
##  Copyright (c) 1999-2002 Vojtech Pavlik
## 
##  This program is free software; you can redistribute it and/or modify it
##  under the terms of the GNU General Public License version 2 as published by
##  the Free Software Foundation.
##

##
##  The event structure itself
##

import posix

type
  input_event* = object
    time*: Timeval
    ev_type*: uint16
    code*: uint16
    value*: int32


##
##  Protocol version.
##

const
  EV_VERSION* = 0x00010001

##
##  IOCTLs (0x00 - 0x7f)
##

type
  input_id* = object
    bustype*: uint16
    vendor*: uint16
    product*: uint16
    version*: uint16


## *
##  struct input_absinfo - used by EVIOCGABS/EVIOCSABS ioctls
##  @value: latest reported value for the axis.
##  @minimum: specifies minimum value for the axis.
##  @maximum: specifies maximum value for the axis.
##  @fuzz: specifies fuzz value that is used to filter noise from
## 	the event stream.
##  @flat: values that are within this value will be discarded by
## 	joydev interface and reported as 0 instead.
##  @resolution: specifies resolution for the values reported for
## 	the axis.
##
##  Note that input core does not clamp reported values to the
##  [minimum, maximum] limits, such task is left to userspace.
##
##  Resolution for main axes (ABS_X, ABS_Y, ABS_Z) is reported in
##  units per millimeter (units/mm), resolution for rotational axes
##  (ABS_RX, ABS_RY, ABS_RZ) is reported in units per radian.
##

type
  input_absinfo* = object
    value*: int32
    minimum*: int32
    maximum*: int32
    fuzz*: int32
    flat*: int32
    resolution*: int32


## *
##  struct input_keymap_entry - used by EVIOCGKEYCODE/EVIOCSKEYCODE ioctls
##  @scancode: scancode represented in machine-endian form.
##  @len: length of the scancode that resides in @scancode buffer.
##  @index: index in the keymap, may be used instead of scancode
##  @flags: allows to specify how kernel should handle the request. For
## 	example, setting INPUT_KEYMAP_BY_INDEX flag indicates that kernel
## 	should perform lookup in keymap by @index instead of @scancode
##  @keycode: key code assigned to this scancode
##
##  The structure is used to retrieve and modify keymap data. Users have
##  option of performing lookup either by @scancode itself or by @index
##  in keymap entry. EVIOCGKEYCODE will also return scancode or index
##  (depending on which element was used to perform lookup).
##

const
  INPUT_KEYMAP_BY_INDEX* = (1 shl 0)

type
  input_keymap_entry* = object
    flags*: uint8
    len*: uint8
    index*: uint16
    keycode*: uint32
    scancode*: array[32, uint8]


##
##  Device properties and quirks
##

const
  INPUT_PROP_POINTER* = 0x00000000
  INPUT_PROP_DIRECT* = 0x00000001
  INPUT_PROP_BUTTONPAD* = 0x00000002
  INPUT_PROP_SEMI_MT* = 0x00000003
  INPUT_PROP_TOPBUTTONPAD* = 0x00000004
  INPUT_PROP_POINTING_STICK* = 0x00000005
  INPUT_PROP_ACCELEROMETER* = 0x00000006
  INPUT_PROP_MAX* = 0x0000001F
  INPUT_PROP_CNT* = (INPUT_PROP_MAX + 1)

##
##  Event types
##

const
  EV_SYN* = 0x00000000
  EV_KEY* = 0x00000001
  EV_REL* = 0x00000002
  EV_ABS* = 0x00000003
  EV_MSC* = 0x00000004
  EV_SW* = 0x00000005
  EV_LED* = 0x00000011
  EV_SND* = 0x00000012
  EV_REP* = 0x00000014
  EV_FF* = 0x00000015
  EV_PWR* = 0x00000016
  EV_FF_STATUS* = 0x00000017
  EV_MAX* = 0x0000001F
  EV_CNT* = (EV_MAX + 1)

##
##  Synchronization events.
##

const
  SYN_REPORT* = 0
  SYN_CONFIG* = 1
  SYN_MT_REPORT* = 2
  SYN_DROPPED* = 3
  SYN_MAX* = 0x0000000F
  SYN_CNT* = (SYN_MAX + 1)

##
##  Keys and buttons
##
##  Most of the keys/buttons are modeled after USB HUT 1.12
##  (see http://www.usb.org/developers/hidpage).
##  Abbreviations in the comments:
##  AC - Application Control
##  AL - Application Launch Button
##  SC - System Control
##

const
  KEY_RESERVED* = 0
  KEY_ESC* = 1
  KEY_1* = 2
  KEY_2* = 3
  KEY_3* = 4
  KEY_4* = 5
  KEY_5* = 6
  KEY_6* = 7
  KEY_7* = 8
  KEY_8* = 9
  KEY_9* = 10
  KEY_0* = 11
  KEY_MINUS* = 12
  KEY_EQUAL* = 13
  KEY_BACKSPACE* = 14
  KEY_TAB* = 15
  KEY_Q* = 16
  KEY_W* = 17
  KEY_E* = 18
  KEY_R* = 19
  KEY_T* = 20
  KEY_Y* = 21
  KEY_U* = 22
  KEY_I* = 23
  KEY_O* = 24
  KEY_P* = 25
  KEY_LEFTBRACE* = 26
  KEY_RIGHTBRACE* = 27
  KEY_ENTER* = 28
  KEY_LEFTCTRL* = 29
  KEY_A* = 30
  KEY_S* = 31
  KEY_D* = 32
  KEY_F* = 33
  KEY_G* = 34
  KEY_H* = 35
  KEY_J* = 36
  KEY_K* = 37
  KEY_L* = 38
  KEY_SEMICOLON* = 39
  KEY_APOSTROPHE* = 40
  KEY_GRAVE* = 41
  KEY_LEFTSHIFT* = 42
  KEY_BACKSLASH* = 43
  KEY_Z* = 44
  KEY_X* = 45
  KEY_C* = 46
  KEY_V* = 47
  KEY_B* = 48
  KEY_N* = 49
  KEY_M* = 50
  KEY_COMMA* = 51
  KEY_DOT* = 52
  KEY_SLASH* = 53
  KEY_RIGHTSHIFT* = 54
  KEY_KPASTERISK* = 55
  KEY_LEFTALT* = 56
  KEY_SPACE* = 57
  KEY_CAPSLOCK* = 58
  KEY_F1* = 59
  KEY_F2* = 60
  KEY_F3* = 61
  KEY_F4* = 62
  KEY_F5* = 63
  KEY_F6* = 64
  KEY_F7* = 65
  KEY_F8* = 66
  KEY_F9* = 67
  KEY_F10* = 68
  KEY_NUMLOCK* = 69
  KEY_SCROLLLOCK* = 70
  KEY_KP7* = 71
  KEY_KP8* = 72
  KEY_KP9* = 73
  KEY_KPMINUS* = 74
  KEY_KP4* = 75
  KEY_KP5* = 76
  KEY_KP6* = 77
  KEY_KPPLUS* = 78
  KEY_KP1* = 79
  KEY_KP2* = 80
  KEY_KP3* = 81
  KEY_KP0* = 82
  KEY_KPDOT* = 83
  KEY_ZENKAKUHANKAKU* = 85
  KEY_102ND* = 86
  KEY_F11* = 87
  KEY_F12* = 88
  KEY_RO* = 89
  KEY_KATAKANA* = 90
  KEY_HIRAGANA* = 91
  KEY_HENKAN* = 92
  KEY_KATAKANAHIRAGANA* = 93
  KEY_MUHENKAN* = 94
  KEY_KPJPCOMMA* = 95
  KEY_KPENTER* = 96
  KEY_RIGHTCTRL* = 97
  KEY_KPSLASH* = 98
  KEY_SYSRQ* = 99
  KEY_RIGHTALT* = 100
  KEY_LINEFEED* = 101
  KEY_HOME* = 102
  KEY_UP* = 103
  KEY_PAGEUP* = 104
  KEY_LEFT* = 105
  KEY_RIGHT* = 106
  KEY_END* = 107
  KEY_DOWN* = 108
  KEY_PAGEDOWN* = 109
  KEY_INSERT* = 110
  KEY_DELETE* = 111
  KEY_MACRO* = 112
  KEY_MUTE* = 113
  KEY_VOLUMEDOWN* = 114
  KEY_VOLUMEUP* = 115
  KEY_POWER* = 116
  KEY_KPEQUAL* = 117
  KEY_KPPLUSMINUS* = 118
  KEY_PAUSE* = 119
  KEY_SCALE* = 120
  KEY_KPCOMMA* = 121
  KEY_HANGEUL* = 122
  KEY_HANGUEL* = KEY_HANGEUL
  KEY_HANJA* = 123
  KEY_YEN* = 124
  KEY_LEFTMETA* = 125
  KEY_RIGHTMETA* = 126
  KEY_COMPOSE* = 127
  KEY_STOP* = 128
  KEY_AGAIN* = 129
  KEY_PROPS* = 130
  KEY_UNDO* = 131
  KEY_FRONT* = 132
  KEY_COPY* = 133
  KEY_OPEN* = 134
  KEY_PASTE* = 135
  KEY_FIND* = 136
  KEY_CUT* = 137
  KEY_HELP* = 138
  KEY_MENU* = 139
  KEY_CALC* = 140
  KEY_SETUP* = 141
  KEY_SLEEP* = 142
  KEY_WAKEUP* = 143
  KEY_FILE* = 144
  KEY_SENDFILE* = 145
  KEY_DELETEFILE* = 146
  KEY_XFER* = 147
  KEY_PROG1* = 148
  KEY_PROG2* = 149
  KEY_WWW* = 150
  KEY_MSDOS* = 151
  KEY_COFFEE* = 152
  KEY_SCREENLOCK* = KEY_COFFEE
  KEY_ROTATE_DISPLAY* = 153
  KEY_DIRECTION* = KEY_ROTATE_DISPLAY
  KEY_CYCLEWINDOWS* = 154
  KEY_MAIL* = 155
  KEY_BOOKMARKS* = 156
  KEY_COMPUTER* = 157
  KEY_BACK* = 158
  KEY_FORWARD* = 159
  KEY_CLOSECD* = 160
  KEY_EJECTCD* = 161
  KEY_EJECTCLOSECD* = 162
  KEY_NEXTSONG* = 163
  KEY_PLAYPAUSE* = 164
  KEY_PREVIOUSSONG* = 165
  KEY_STOPCD* = 166
  KEY_RECORD* = 167
  KEY_REWIND* = 168
  KEY_PHONE* = 169
  KEY_ISO* = 170
  KEY_CONFIG* = 171
  KEY_HOMEPAGE* = 172
  KEY_REFRESH* = 173
  KEY_EXIT* = 174
  KEY_MOVE* = 175
  KEY_EDIT* = 176
  KEY_SCROLLUP* = 177
  KEY_SCROLLDOWN* = 178
  KEY_KPLEFTPAREN* = 179
  KEY_KPRIGHTPAREN* = 180
  KEY_NEW* = 181
  KEY_REDO* = 182
  KEY_F13* = 183
  KEY_F14* = 184
  KEY_F15* = 185
  KEY_F16* = 186
  KEY_F17* = 187
  KEY_F18* = 188
  KEY_F19* = 189
  KEY_F20* = 190
  KEY_F21* = 191
  KEY_F22* = 192
  KEY_F23* = 193
  KEY_F24* = 194
  KEY_PLAYCD* = 200
  KEY_PAUSECD* = 201
  KEY_PROG3* = 202
  KEY_PROG4* = 203
  KEY_DASHBOARD* = 204
  KEY_SUSPEND* = 205
  KEY_CLOSE* = 206
  KEY_PLAY* = 207
  KEY_FASTFORWARD* = 208
  KEY_BASSBOOST* = 209
  KEY_PRINT* = 210
  KEY_HP* = 211
  KEY_CAMERA* = 212
  KEY_SOUND* = 213
  KEY_QUESTION* = 214
  KEY_EMAIL* = 215
  KEY_CHAT* = 216
  KEY_SEARCH* = 217
  KEY_CONNECT* = 218
  KEY_FINANCE* = 219
  KEY_SPORT* = 220
  KEY_SHOP* = 221
  KEY_ALTERASE* = 222
  KEY_CANCEL* = 223
  KEY_BRIGHTNESSDOWN* = 224
  KEY_BRIGHTNESSUP* = 225
  KEY_MEDIA* = 226
  KEY_SWITCHVIDEOMODE* = 227
  KEY_KBDILLUMTOGGLE* = 228
  KEY_KBDILLUMDOWN* = 229
  KEY_KBDILLUMUP* = 230
  KEY_SEND* = 231
  KEY_REPLY* = 232
  KEY_FORWARDMAIL* = 233
  KEY_SAVE* = 234
  KEY_DOCUMENTS* = 235
  KEY_BATTERY* = 236
  KEY_BLUETOOTH* = 237
  KEY_WLAN* = 238
  KEY_UWB* = 239
  KEY_UNKNOWN* = 240
  KEY_VIDEO_NEXT* = 241
  KEY_VIDEO_PREV* = 242
  KEY_BRIGHTNESS_CYCLE* = 243
  KEY_BRIGHTNESS_AUTO* = 244
  KEY_BRIGHTNESS_ZERO* = KEY_BRIGHTNESS_AUTO
  KEY_DISPLAY_OFF* = 245
  KEY_WWAN* = 246
  KEY_WIMAX* = KEY_WWAN
  KEY_RFKILL* = 247
  KEY_MICMUTE* = 248

##  Code 255 is reserved for special needs of AT keyboard driver

const
  BTN_MISC* = 0x00000100
  BTN_0* = 0x00000100
  BTN_1* = 0x00000101
  BTN_2* = 0x00000102
  BTN_3* = 0x00000103
  BTN_4* = 0x00000104
  BTN_5* = 0x00000105
  BTN_6* = 0x00000106
  BTN_7* = 0x00000107
  BTN_8* = 0x00000108
  BTN_9* = 0x00000109
  BTN_MOUSE* = 0x00000110
  BTN_LEFT* = 0x00000110
  BTN_RIGHT* = 0x00000111
  BTN_MIDDLE* = 0x00000112
  BTN_SIDE* = 0x00000113
  BTN_EXTRA* = 0x00000114
  BTN_FORWARD* = 0x00000115
  BTN_BACK* = 0x00000116
  BTN_TASK* = 0x00000117
  BTN_JOYSTICK* = 0x00000120
  BTN_TRIGGER* = 0x00000120
  BTN_THUMB* = 0x00000121
  BTN_THUMB2* = 0x00000122
  BTN_TOP* = 0x00000123
  BTN_TOP2* = 0x00000124
  BTN_PINKIE* = 0x00000125
  BTN_BASE* = 0x00000126
  BTN_BASE2* = 0x00000127
  BTN_BASE3* = 0x00000128
  BTN_BASE4* = 0x00000129
  BTN_BASE5* = 0x0000012A
  BTN_BASE6* = 0x0000012B
  BTN_DEAD* = 0x0000012F
  BTN_GAMEPAD* = 0x00000130
  BTN_SOUTH* = 0x00000130
  BTN_A* = BTN_SOUTH
  BTN_EAST* = 0x00000131
  BTN_B* = BTN_EAST
  BTN_C* = 0x00000132
  BTN_NORTH* = 0x00000133
  BTN_X* = BTN_NORTH
  BTN_WEST* = 0x00000134
  BTN_Y* = BTN_WEST
  BTN_Z* = 0x00000135
  BTN_TL* = 0x00000136
  BTN_TR* = 0x00000137
  BTN_TL2* = 0x00000138
  BTN_TR2* = 0x00000139
  BTN_SELECT* = 0x0000013A
  BTN_START* = 0x0000013B
  BTN_MODE* = 0x0000013C
  BTN_THUMBL* = 0x0000013D
  BTN_THUMBR* = 0x0000013E
  BTN_DIGI* = 0x00000140
  BTN_TOOL_PEN* = 0x00000140
  BTN_TOOL_RUBBER* = 0x00000141
  BTN_TOOL_BRUSH* = 0x00000142
  BTN_TOOL_PENCIL* = 0x00000143
  BTN_TOOL_AIRBRUSH* = 0x00000144
  BTN_TOOL_FINGER* = 0x00000145
  BTN_TOOL_MOUSE* = 0x00000146
  BTN_TOOL_LENS* = 0x00000147
  BTN_TOOL_QUINTTAP* = 0x00000148
  BTN_TOUCH* = 0x0000014A
  BTN_STYLUS* = 0x0000014B
  BTN_STYLUS2* = 0x0000014C
  BTN_TOOL_DOUBLETAP* = 0x0000014D
  BTN_TOOL_TRIPLETAP* = 0x0000014E
  BTN_TOOL_QUADTAP* = 0x0000014F
  BTN_WHEEL* = 0x00000150
  BTN_GEAR_DOWN* = 0x00000150
  BTN_GEAR_UP* = 0x00000151
  KEY_OK* = 0x00000160
  KEY_SELECT* = 0x00000161
  KEY_GOTO* = 0x00000162
  KEY_CLEAR* = 0x00000163
  KEY_POWER2* = 0x00000164
  KEY_OPTION* = 0x00000165
  KEY_INFO* = 0x00000166
  KEY_TIME* = 0x00000167
  KEY_VENDOR* = 0x00000168
  KEY_ARCHIVE* = 0x00000169
  KEY_PROGRAM* = 0x0000016A
  KEY_CHANNEL* = 0x0000016B
  KEY_FAVORITES* = 0x0000016C
  KEY_EPG* = 0x0000016D
  KEY_PVR* = 0x0000016E
  KEY_MHP* = 0x0000016F
  KEY_LANGUAGE* = 0x00000170
  KEY_TITLE* = 0x00000171
  KEY_SUBTITLE* = 0x00000172
  KEY_ANGLE* = 0x00000173
  KEY_ZOOM* = 0x00000174
  KEY_MODE* = 0x00000175
  KEY_KEYBOARD* = 0x00000176
  KEY_SCREEN* = 0x00000177
  KEY_PC* = 0x00000178
  KEY_TV* = 0x00000179
  KEY_TV2* = 0x0000017A
  KEY_VCR* = 0x0000017B
  KEY_VCR2* = 0x0000017C
  KEY_SAT* = 0x0000017D
  KEY_SAT2* = 0x0000017E
  KEY_CD* = 0x0000017F
  KEY_TAPE* = 0x00000180
  KEY_RADIO* = 0x00000181
  KEY_TUNER* = 0x00000182
  KEY_PLAYER* = 0x00000183
  KEY_TEXT* = 0x00000184
  KEY_DVD* = 0x00000185
  KEY_AUX* = 0x00000186
  KEY_MP3* = 0x00000187
  KEY_AUDIO* = 0x00000188
  KEY_VIDEO* = 0x00000189
  KEY_DIRECTORY* = 0x0000018A
  KEY_LIST* = 0x0000018B
  KEY_MEMO* = 0x0000018C
  KEY_CALENDAR* = 0x0000018D
  KEY_RED* = 0x0000018E
  KEY_GREEN* = 0x0000018F
  KEY_YELLOW* = 0x00000190
  KEY_BLUE* = 0x00000191
  KEY_CHANNELUP* = 0x00000192
  KEY_CHANNELDOWN* = 0x00000193
  KEY_FIRST* = 0x00000194
  KEY_LAST* = 0x00000195
  KEY_AB* = 0x00000196
  KEY_NEXT* = 0x00000197
  KEY_RESTART* = 0x00000198
  KEY_SLOW* = 0x00000199
  KEY_SHUFFLE* = 0x0000019A
  KEY_BREAK* = 0x0000019B
  KEY_PREVIOUS* = 0x0000019C
  KEY_DIGITS* = 0x0000019D
  KEY_TEEN* = 0x0000019E
  KEY_TWEN* = 0x0000019F
  KEY_VIDEOPHONE* = 0x000001A0
  KEY_GAMES* = 0x000001A1
  KEY_ZOOMIN* = 0x000001A2
  KEY_ZOOMOUT* = 0x000001A3
  KEY_ZOOMRESET* = 0x000001A4
  KEY_WORDPROCESSOR* = 0x000001A5
  KEY_EDITOR* = 0x000001A6
  KEY_SPREADSHEET* = 0x000001A7
  KEY_GRAPHICSEDITOR* = 0x000001A8
  KEY_PRESENTATION* = 0x000001A9
  KEY_DATABASE* = 0x000001AA
  KEY_NEWS* = 0x000001AB
  KEY_VOICEMAIL* = 0x000001AC
  KEY_ADDRESSBOOK* = 0x000001AD
  KEY_MESSENGER* = 0x000001AE
  KEY_DISPLAYTOGGLE* = 0x000001AF
  KEY_BRIGHTNESS_TOGGLE* = KEY_DISPLAYTOGGLE
  KEY_SPELLCHECK* = 0x000001B0
  KEY_LOGOFF* = 0x000001B1
  KEY_DOLLAR* = 0x000001B2
  KEY_EURO* = 0x000001B3
  KEY_FRAMEBACK* = 0x000001B4
  KEY_FRAMEFORWARD* = 0x000001B5
  KEY_CONTEXT_MENU* = 0x000001B6
  KEY_MEDIA_REPEAT* = 0x000001B7
  KEY_10CHANNELSUP* = 0x000001B8
  KEY_10CHANNELSDOWN* = 0x000001B9
  KEY_IMAGES* = 0x000001BA
  KEY_DEL_EOL* = 0x000001C0
  KEY_DEL_EOS* = 0x000001C1
  KEY_INS_LINE* = 0x000001C2
  KEY_DEL_LINE* = 0x000001C3
  KEY_FN* = 0x000001D0
  KEY_FN_ESC* = 0x000001D1
  KEY_FN_F1* = 0x000001D2
  KEY_FN_F2* = 0x000001D3
  KEY_FN_F3* = 0x000001D4
  KEY_FN_F4* = 0x000001D5
  KEY_FN_F5* = 0x000001D6
  KEY_FN_F6* = 0x000001D7
  KEY_FN_F7* = 0x000001D8
  KEY_FN_F8* = 0x000001D9
  KEY_FN_F9* = 0x000001DA
  KEY_FN_F10* = 0x000001DB
  KEY_FN_F11* = 0x000001DC
  KEY_FN_F12* = 0x000001DD
  KEY_FN_1* = 0x000001DE
  KEY_FN_2* = 0x000001DF
  KEY_FN_D* = 0x000001E0
  KEY_FN_E* = 0x000001E1
  KEY_FN_F* = 0x000001E2
  KEY_FN_S* = 0x000001E3
  KEY_FN_B* = 0x000001E4
  KEY_BRL_DOT1* = 0x000001F1
  KEY_BRL_DOT2* = 0x000001F2
  KEY_BRL_DOT3* = 0x000001F3
  KEY_BRL_DOT4* = 0x000001F4
  KEY_BRL_DOT5* = 0x000001F5
  KEY_BRL_DOT6* = 0x000001F6
  KEY_BRL_DOT7* = 0x000001F7
  KEY_BRL_DOT8* = 0x000001F8
  KEY_BRL_DOT9* = 0x000001F9
  KEY_BRL_DOT10* = 0x000001FA
  KEY_NUMERIC_0* = 0x00000200
  KEY_NUMERIC_1* = 0x00000201
  KEY_NUMERIC_2* = 0x00000202
  KEY_NUMERIC_3* = 0x00000203
  KEY_NUMERIC_4* = 0x00000204
  KEY_NUMERIC_5* = 0x00000205
  KEY_NUMERIC_6* = 0x00000206
  KEY_NUMERIC_7* = 0x00000207
  KEY_NUMERIC_8* = 0x00000208
  KEY_NUMERIC_9* = 0x00000209
  KEY_NUMERIC_STAR* = 0x0000020A
  KEY_NUMERIC_POUND* = 0x0000020B
  KEY_NUMERIC_A* = 0x0000020C
  KEY_NUMERIC_B* = 0x0000020D
  KEY_NUMERIC_C* = 0x0000020E
  KEY_NUMERIC_D* = 0x0000020F
  KEY_CAMERA_FOCUS* = 0x00000210
  KEY_WPS_BUTTON* = 0x00000211
  KEY_TOUCHPAD_TOGGLE* = 0x00000212
  KEY_TOUCHPAD_ON* = 0x00000213
  KEY_TOUCHPAD_OFF* = 0x00000214
  KEY_CAMERA_ZOOMIN* = 0x00000215
  KEY_CAMERA_ZOOMOUT* = 0x00000216
  KEY_CAMERA_UP* = 0x00000217
  KEY_CAMERA_DOWN* = 0x00000218
  KEY_CAMERA_LEFT* = 0x00000219
  KEY_CAMERA_RIGHT* = 0x0000021A
  KEY_ATTENDANT_ON* = 0x0000021B
  KEY_ATTENDANT_OFF* = 0x0000021C
  KEY_ATTENDANT_TOGGLE* = 0x0000021D
  KEY_LIGHTS_TOGGLE* = 0x0000021E
  BTN_DPAD_UP* = 0x00000220
  BTN_DPAD_DOWN* = 0x00000221
  BTN_DPAD_LEFT* = 0x00000222
  BTN_DPAD_RIGHT* = 0x00000223
  KEY_ALS_TOGGLE* = 0x00000230
  KEY_BUTTONCONFIG* = 0x00000240
  KEY_TASKMANAGER* = 0x00000241
  KEY_JOURNAL* = 0x00000242
  KEY_CONTROLPANEL* = 0x00000243
  KEY_APPSELECT* = 0x00000244
  KEY_SCREENSAVER* = 0x00000245
  KEY_VOICECOMMAND* = 0x00000246
  KEY_BRIGHTNESS_MIN* = 0x00000250
  KEY_BRIGHTNESS_MAX* = 0x00000251
  KEY_KBDINPUTASSIST_PREV* = 0x00000260
  KEY_KBDINPUTASSIST_NEXT* = 0x00000261
  KEY_KBDINPUTASSIST_PREVGROUP* = 0x00000262
  KEY_KBDINPUTASSIST_NEXTGROUP* = 0x00000263
  KEY_KBDINPUTASSIST_ACCEPT* = 0x00000264
  KEY_KBDINPUTASSIST_CANCEL* = 0x00000265
  BTN_TRIGGER_HAPPY* = 0x000002C0
  BTN_TRIGGER_HAPPY1* = 0x000002C0
  BTN_TRIGGER_HAPPY2* = 0x000002C1
  BTN_TRIGGER_HAPPY3* = 0x000002C2
  BTN_TRIGGER_HAPPY4* = 0x000002C3
  BTN_TRIGGER_HAPPY5* = 0x000002C4
  BTN_TRIGGER_HAPPY6* = 0x000002C5
  BTN_TRIGGER_HAPPY7* = 0x000002C6
  BTN_TRIGGER_HAPPY8* = 0x000002C7
  BTN_TRIGGER_HAPPY9* = 0x000002C8
  BTN_TRIGGER_HAPPY10* = 0x000002C9
  BTN_TRIGGER_HAPPY11* = 0x000002CA
  BTN_TRIGGER_HAPPY12* = 0x000002CB
  BTN_TRIGGER_HAPPY13* = 0x000002CC
  BTN_TRIGGER_HAPPY14* = 0x000002CD
  BTN_TRIGGER_HAPPY15* = 0x000002CE
  BTN_TRIGGER_HAPPY16* = 0x000002CF
  BTN_TRIGGER_HAPPY17* = 0x000002D0
  BTN_TRIGGER_HAPPY18* = 0x000002D1
  BTN_TRIGGER_HAPPY19* = 0x000002D2
  BTN_TRIGGER_HAPPY20* = 0x000002D3
  BTN_TRIGGER_HAPPY21* = 0x000002D4
  BTN_TRIGGER_HAPPY22* = 0x000002D5
  BTN_TRIGGER_HAPPY23* = 0x000002D6
  BTN_TRIGGER_HAPPY24* = 0x000002D7
  BTN_TRIGGER_HAPPY25* = 0x000002D8
  BTN_TRIGGER_HAPPY26* = 0x000002D9
  BTN_TRIGGER_HAPPY27* = 0x000002DA
  BTN_TRIGGER_HAPPY28* = 0x000002DB
  BTN_TRIGGER_HAPPY29* = 0x000002DC
  BTN_TRIGGER_HAPPY30* = 0x000002DD
  BTN_TRIGGER_HAPPY31* = 0x000002DE
  BTN_TRIGGER_HAPPY32* = 0x000002DF
  BTN_TRIGGER_HAPPY33* = 0x000002E0
  BTN_TRIGGER_HAPPY34* = 0x000002E1
  BTN_TRIGGER_HAPPY35* = 0x000002E2
  BTN_TRIGGER_HAPPY36* = 0x000002E3
  BTN_TRIGGER_HAPPY37* = 0x000002E4
  BTN_TRIGGER_HAPPY38* = 0x000002E5
  BTN_TRIGGER_HAPPY39* = 0x000002E6
  BTN_TRIGGER_HAPPY40* = 0x000002E7

##  We avoid low common keys in module aliases so they don't get huge.

const
  KEY_MIN_INTERESTING* = KEY_MUTE
  KEY_MAX* = 0x000002FF
  KEY_CNT* = (KEY_MAX + 1)

##
##  Relative axes
##

const
  REL_X* = 0x00000000
  REL_Y* = 0x00000001
  REL_Z* = 0x00000002
  REL_RX* = 0x00000003
  REL_RY* = 0x00000004
  REL_RZ* = 0x00000005
  REL_HWHEEL* = 0x00000006
  REL_DIAL* = 0x00000007
  REL_WHEEL* = 0x00000008
  REL_MISC* = 0x00000009
  REL_MAX* = 0x0000000F
  REL_CNT* = (REL_MAX + 1)

##
##  Absolute axes
##

const
  ABS_X* = 0x00000000
  ABS_Y* = 0x00000001
  ABS_Z* = 0x00000002
  ABS_RX* = 0x00000003
  ABS_RY* = 0x00000004
  ABS_RZ* = 0x00000005
  ABS_THROTTLE* = 0x00000006
  ABS_RUDDER* = 0x00000007
  ABS_WHEEL* = 0x00000008
  ABS_GAS* = 0x00000009
  ABS_BRAKE* = 0x0000000A
  ABS_HAT0X* = 0x00000010
  ABS_HAT0Y* = 0x00000011
  ABS_HAT1X* = 0x00000012
  ABS_HAT1Y* = 0x00000013
  ABS_HAT2X* = 0x00000014
  ABS_HAT2Y* = 0x00000015
  ABS_HAT3X* = 0x00000016
  ABS_HAT3Y* = 0x00000017
  ABS_PRESSURE* = 0x00000018
  ABS_DISTANCE* = 0x00000019
  ABS_TILT_X* = 0x0000001A
  ABS_TILT_Y* = 0x0000001B
  ABS_TOOL_WIDTH* = 0x0000001C
  ABS_VOLUME* = 0x00000020
  ABS_MISC* = 0x00000028
  ABS_MT_SLOT* = 0x0000002F
  ABS_MT_TOUCH_MAJOR* = 0x00000030
  ABS_MT_TOUCH_MINOR* = 0x00000031
  ABS_MT_WIDTH_MAJOR* = 0x00000032
  ABS_MT_WIDTH_MINOR* = 0x00000033
  ABS_MT_ORIENTATION* = 0x00000034
  ABS_MT_POSITION_X* = 0x00000035
  ABS_MT_POSITION_Y* = 0x00000036
  ABS_MT_TOOL_TYPE* = 0x00000037
  ABS_MT_BLOB_ID* = 0x00000038
  ABS_MT_TRACKING_ID* = 0x00000039
  ABS_MT_PRESSURE* = 0x0000003A
  ABS_MT_DISTANCE* = 0x0000003B
  ABS_MT_TOOL_X* = 0x0000003C
  ABS_MT_TOOL_Y* = 0x0000003D
  ABS_MAX* = 0x0000003F
  ABS_CNT* = (ABS_MAX + 1)

##
##  Switch events
##

const
  SW_LID* = 0x00000000
  SW_TABLET_MODE* = 0x00000001
  SW_HEADPHONE_INSERT* = 0x00000002
  SW_RFKILL_ALL* = 0x00000003
  SW_RADIO* = SW_RFKILL_ALL
  SW_MICROPHONE_INSERT* = 0x00000004
  SW_DOCK* = 0x00000005
  SW_LINEOUT_INSERT* = 0x00000006
  SW_JACK_PHYSICAL_INSERT* = 0x00000007
  SW_VIDEOOUT_INSERT* = 0x00000008
  SW_CAMERA_LENS_COVER* = 0x00000009
  SW_KEYPAD_SLIDE* = 0x0000000A
  SW_FRONT_PROXIMITY* = 0x0000000B
  SW_ROTATE_LOCK* = 0x0000000C
  SW_LINEIN_INSERT* = 0x0000000D
  SW_MUTE_DEVICE* = 0x0000000E
  SW_MAX* = 0x0000000F
  SW_CNT* = (SW_MAX + 1)

##
##  Misc events
##

const
  MSC_SERIAL* = 0x00000000
  MSC_PULSELED* = 0x00000001
  MSC_GESTURE* = 0x00000002
  MSC_RAW* = 0x00000003
  MSC_SCAN* = 0x00000004
  MSC_TIMESTAMP* = 0x00000005
  MSC_MAX* = 0x00000007
  MSC_CNT* = (MSC_MAX + 1)

##
##  LEDs
##

const
  LED_NUML* = 0x00000000
  LED_CAPSL* = 0x00000001
  LED_SCROLLL* = 0x00000002
  LED_COMPOSE* = 0x00000003
  LED_KANA* = 0x00000004
  LED_SLEEP* = 0x00000005
  LED_SUSPEND* = 0x00000006
  LED_MUTE* = 0x00000007
  LED_MISC* = 0x00000008
  LED_MAIL* = 0x00000009
  LED_CHARGING* = 0x0000000A
  LED_MAX* = 0x0000000F
  LED_CNT* = (LED_MAX + 1)

##
##  Autorepeat values
##

const
  REP_DELAY* = 0x00000000
  REP_PERIOD* = 0x00000001
  REP_MAX* = 0x00000001
  REP_CNT* = (REP_MAX + 1)

##
##  Sounds
##

const
  SND_CLICK* = 0x00000000
  SND_BELL* = 0x00000001
  SND_TONE* = 0x00000002
  SND_MAX* = 0x00000007
  SND_CNT* = (SND_MAX + 1)

##
##  IDs.
##

const
  ID_BUS* = 0
  ID_VENDOR* = 1
  ID_PRODUCT* = 2
  ID_VERSION* = 3
  BUS_PCI* = 0x00000001
  BUS_ISAPNP* = 0x00000002
  BUS_USB* = 0x00000003
  BUS_HIL* = 0x00000004
  BUS_BLUETOOTH* = 0x00000005
  BUS_VIRTUAL* = 0x00000006
  BUS_ISA* = 0x00000010
  BUS_I8042* = 0x00000011
  BUS_XTKBD* = 0x00000012
  BUS_RS232* = 0x00000013
  BUS_GAMEPORT* = 0x00000014
  BUS_PARPORT* = 0x00000015
  BUS_AMIGA* = 0x00000016
  BUS_ADB* = 0x00000017
  BUS_I2C* = 0x00000018
  BUS_HOST* = 0x00000019
  BUS_GSC* = 0x0000001A
  BUS_ATARI* = 0x0000001B
  BUS_SPI* = 0x0000001C

##
##  MT_TOOL types
##

const
  MT_TOOL_FINGER* = 0
  MT_TOOL_PEN* = 1
  MT_TOOL_PALM* = 2
  MT_TOOL_MAX* = 2

##
##  Values describing the status of a force-feedback effect
##

const
  FF_STATUS_STOPPED* = 0x00000000
  FF_STATUS_PLAYING* = 0x00000001
  FF_STATUS_MAX* = 0x00000001

##
##  Structures used in ioctls to upload effects to a device
##  They are pieces of a bigger structure (called ff_effect)
##
##
##  All duration values are expressed in ms. Values above 32767 ms (0x7fff)
##  should not be used and have unspecified results.
##
## *
##  struct ff_replay - defines scheduling of the force-feedback effect
##  @length: duration of the effect
##  @delay: delay before effect should start playing
##

type
  ff_replay* = object
    length*: uint16
    delay*: uint16


## *
##  struct ff_trigger - defines what triggers the force-feedback effect
##  @button: number of the button triggering the effect
##  @interval: controls how soon the effect can be re-triggered
##

type
  ff_trigger* = object
    button*: uint16
    interval*: uint16


## *
##  struct ff_envelope - generic force-feedback effect envelope
##  @attack_length: duration of the attack (ms)
##  @attack_level: level at the beginning of the attack
##  @fade_length: duration of fade (ms)
##  @fade_level: level at the end of fade
##
##  The @attack_level and @fade_level are absolute values; when applying
##  envelope force-feedback core will convert to positive/negative
##  value based on polarity of the default level of the effect.
##  Valid range for the attack and fade levels is 0x0000 - 0x7fff
##

type
  ff_envelope* = object
    attack_length*: uint16
    attack_level*: uint16
    fade_length*: uint16
    fade_level*: uint16


## *
##  struct ff_constant_effect - defines parameters of a constant force-feedback effect
##  @level: strength of the effect; may be negative
##  @envelope: envelope data
##

type
  ff_constant_effect* = object
    level*: int16
    envelope*: ff_envelope


## *
##  struct ff_ramp_effect - defines parameters of a ramp force-feedback effect
##  @start_level: beginning strength of the effect; may be negative
##  @end_level: final strength of the effect; may be negative
##  @envelope: envelope data
##

type
  ff_ramp_effect* = object
    start_level*: int16
    end_level*: int16
    envelope*: ff_envelope


## *
##  struct ff_condition_effect - defines a spring or friction force-feedback effect
##  @right_saturation: maximum level when joystick moved all way to the right
##  @left_saturation: same for the left side
##  @right_coeff: controls how fast the force grows when the joystick moves
## 	to the right
##  @left_coeff: same for the left side
##  @deadband: size of the dead zone, where no force is produced
##  @center: position of the dead zone
##

type
  ff_condition_effect* = object
    right_saturation*: uint16
    left_saturation*: uint16
    right_coeff*: int16
    left_coeff*: int16
    deadband*: uint16
    center*: int16


## *
##  struct ff_periodic_effect - defines parameters of a periodic force-feedback effect
##  @waveform: kind of the effect (wave)
##  @period: period of the wave (ms)
##  @magnitude: peak value
##  @offset: mean value of the wave (roughly)
##  @phase: 'horizontal' shift
##  @envelope: envelope data
##  @custom_len: number of samples (FF_CUSTOM only)
##  @custom_data: buffer of samples (FF_CUSTOM only)
##
##  Known waveforms - FF_SQUARE, FF_TRIANGLE, FF_SINE, FF_SAW_UP,
##  FF_SAW_DOWN, FF_CUSTOM. The exact syntax FF_CUSTOM is undefined
##  for the time being as no driver supports it yet.
##
##  Note: the data pointed by custom_data is copied by the driver.
##  You can therefore dispose of the memory after the upload/update.
##

type
  ff_periodic_effect* = object
    waveform*: uint16
    period*: uint16
    magnitude*: int16
    offset*: int16
    phase*: uint16
    envelope*: ff_envelope
    custom_len*: uint32
    custom_data*: ptr int16


## *
##  struct ff_rumble_effect - defines parameters of a periodic force-feedback effect
##  @strong_magnitude: magnitude of the heavy motor
##  @weak_magnitude: magnitude of the light one
##
##  Some rumble pads have two motors of different weight. Strong_magnitude
##  represents the magnitude of the vibration generated by the heavy one.
##

type
  ff_rumble_effect* = object
    strong_magnitude*: uint16
    weak_magnitude*: uint16


## *
##  struct ff_effect - defines force feedback effect
##  @type: type of the effect (FF_CONSTANT, FF_PERIODIC, FF_RAMP, FF_SPRING,
## 	FF_FRICTION, FF_DAMPER, FF_RUMBLE, FF_INERTIA, or FF_CUSTOM)
##  @id: an unique id assigned to an effect
##  @direction: direction of the effect
##  @trigger: trigger conditions (struct ff_trigger)
##  @replay: scheduling of the effect (struct ff_replay)
##  @u: effect-specific structure (one of ff_constant_effect, ff_ramp_effect,
## 	ff_periodic_effect, ff_condition_effect, ff_rumble_effect) further
## 	defining effect parameters
##
##  This structure is sent through ioctl from the application to the driver.
##  To create a new effect application should set its @id to -1; the kernel
##  will return assigned @id which can later be used to update or delete
##  this effect.
##
##  Direction of the effect is encoded as follows:
## 	0 deg -> 0x0000 (down)
## 	90 deg -> 0x4000 (left)
## 	180 deg -> 0x8000 (up)
## 	270 deg -> 0xC000 (right)
##

# type
#   INNER_C_UNION_3762273487* = object {.union.}
#     constant*: ff_constant_effect
#     ramp*: ff_ramp_effect
#     periodic*: ff_periodic_effect
#     condition*: array[2, ff_condition_effect] ##  One for each axis
#     rumble*: ff_rumble_effect

#   ff_effect* = object
#     `type`*: uint16
#     id*: int16
#     direction*: uint16
#     trigger*: ff_trigger
#     replay*: ff_replay
#     u*: INNER_C_UNION_3762273487


##
##  Force feedback effect types
##

const
  FF_RUMBLE* = 0x00000050
  FF_PERIODIC* = 0x00000051
  FF_CONSTANT* = 0x00000052
  FF_SPRING* = 0x00000053
  FF_FRICTION* = 0x00000054
  FF_DAMPER* = 0x00000055
  FF_INERTIA* = 0x00000056
  FF_RAMP* = 0x00000057
  FF_EFFECT_MIN* = FF_RUMBLE
  FF_EFFECT_MAX* = FF_RAMP

##
##  Force feedback periodic effect types
##

const
  FF_SQUARE* = 0x00000058
  FF_TRIANGLE* = 0x00000059
  FF_SINE* = 0x0000005A
  FF_SAW_UP* = 0x0000005B
  FF_SAW_DOWN* = 0x0000005C
  FF_CUSTOM* = 0x0000005D
  FF_WAVEFORM_MIN* = FF_SQUARE
  FF_WAVEFORM_MAX* = FF_CUSTOM

##
##  Set ff device properties
##

const
  FF_GAIN* = 0x00000060
  FF_AUTOCENTER* = 0x00000061
  FF_MAX* = 0x0000007F
  FF_CNT* = (FF_MAX + 1)
