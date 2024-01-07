{.passl: "-lgpiod".}
##  SPDX-License-Identifier: LGPL-2.1-or-later
##  SPDX-FileCopyrightText: 2017-2022 Bartosz Golaszewski <brgl@bgdev.pl>
##
##  @file gpiod.h
##

##
##  @mainpage libgpiod public API
##
##  This is the complete documentation of the public API made available to
##  users of libgpiod.
##
##  The API is logically split into several sections. For each opaque data
##  class, there's a set of functions for manipulating it. Together they can be
##  thought of as objects and their methods in OOP parlance.
##
##  General note on error handling: all functions exported by libgpiod that
##  can fail, set errno to one of the error values defined in errno.h upon
##  failure. The way of notifying the caller that an error occurred varies
##  between functions, but in general a function that returns an int, returns -1
##  on error, while a function returning a pointer indicates an error condition
##  by returning a NULL pointer. It's not practical to list all possible error
##  codes for every function as they propagate errors from the underlying libc
##  functions.
##
##  In general libgpiod functions are NULL-aware. For functions that are
##  logically methods of data classes - ones that take a pointer to the object
##  of that class as the first argument - passing a NULL pointer will result in
##  the program aborting the execution. For non-methods, init functions and
##  methods that take a pointer as any of the subsequent arguments, the handling
##  of a NULL-pointer depends on the implementation and may range from gracefully
##  handling it, ignoring it or returning an error.
##
##  libgpiod is thread-aware but does not provide any further thread-safety
##  guarantees. This requires the user to ensure that at most one thread may
##  work with an object at any time. Sharing objects across threads is allowed
##  if a suitable synchronization mechanism serializes the access. Different,
##  standalone objects can safely be used concurrently. Most libgpiod objects
##  are standalone. Exceptions - such as events allocated in buffers - exist and
##  are noted in the documentation.
##
##
##  @struct gpiod_chip
##  @{
##
##  Refer to @ref chips for functions that operate on gpiod_chip.
##
##  @}
##

discard "forward decl of gpiod_chip"
discard "forward decl of gpiod_chip_info"
discard "forward decl of gpiod_line_info"
discard "forward decl of gpiod_line_settings"
discard "forward decl of gpiod_line_config"
discard "forward decl of gpiod_request_config"
discard "forward decl of gpiod_line_request"
discard "forward decl of gpiod_info_event"
discard "forward decl of gpiod_edge_event"
discard "forward decl of gpiod_edge_event_buffer"
proc gpiod_chip_open*(path: cstring): ptr gpiod_chip {.importc: "gpiod_chip_open".}
##
##  @brief Close the chip and release all associated resources.
##  @param chip Chip to close.
##

proc gpiod_chip_close*(chip: ptr gpiod_chip) {.importc: "gpiod_chip_close".}
##
##  @brief Get information about the chip.
##  @param chip GPIO chip object.
##  @return New GPIO chip info object or NULL if an error occurred. The returned
##          object must be freed by the caller using ::gpiod_chip_info_free.
##

proc gpiod_chip_get_info*(chip: ptr gpiod_chip): ptr gpiod_chip_info {.
    importc: "gpiod_chip_get_info".}
##
##  @brief Get the path used to open the chip.
##  @param chip GPIO chip object.
##  @return Path to the file passed as argument to ::gpiod_chip_open. The
##          returned pointer is valid for the lifetime of the chip object and
##          must not be freed by the caller.
##

proc gpiod_chip_get_path*(chip: ptr gpiod_chip): cstring {.
    importc: "gpiod_chip_get_path".}
##
##  @brief Get a snapshot of information about a line.
##  @param chip GPIO chip object.
##  @param offset The offset of the GPIO line.
##  @return New GPIO line info object or NULL if an error occurred. The returned
##          object must be freed by the caller using ::gpiod_line_info_free.
##

proc gpiod_chip_get_line_info*(chip: ptr gpiod_chip; offset: cuint): ptr gpiod_line_info {.
    importc: "gpiod_chip_get_line_info".}
##
##  @brief Get a snapshot of the status of a line and start watching it for
##         future changes.
##  @param chip GPIO chip object.
##  @param offset The offset of the GPIO line.
##  @return New GPIO line info object or NULL if an error occurred. The returned
##          object must be freed by the caller using ::gpiod_line_info_free.
##  @note Line status does not include the line value. To monitor the line
##        value the line must be requested as an input with edge detection set.
##

proc gpiod_chip_watch_line_info*(chip: ptr gpiod_chip; offset: cuint): ptr gpiod_line_info {.
    importc: "gpiod_chip_watch_line_info".}
##
##  @brief Stop watching a line for status changes.
##  @param chip GPIO chip object.
##  @param offset The offset of the line to stop watching.
##  @return 0 on success, -1 on failure.
##

proc gpiod_chip_unwatch_line_info*(chip: ptr gpiod_chip; offset: cuint): cint {.
    importc: "gpiod_chip_unwatch_line_info".}
##
##  @brief Get the file descriptor associated with the chip.
##  @param chip GPIO chip object.
##  @return File descriptor number for the chip.
##
##  This function never fails. The returned file descriptor must not be closed
##  by the caller. Call ::gpiod_chip_close to close the file descriptor by
##  closing the chip owning it.
##

proc gpiod_chip_get_fd*(chip: ptr gpiod_chip): cint {.importc: "gpiod_chip_get_fd".}
##
##  @brief Wait for line status change events on any of the watched lines
##         on the chip.
##  @param chip GPIO chip object.
##  @param timeout_ns Wait time limit in nanoseconds. If set to 0, the function
##                    returns immediatelly. If set to a negative number, the
##                    function blocks indefinitely until an event becomes
##                    available.
##  @return 0 if wait timed out, -1 if an error occurred, 1 if an event is
##          pending.
##

proc gpiod_chip_wait_info_event*(chip: ptr gpiod_chip; timeout_ns: int64_t): cint {.
    importc: "gpiod_chip_wait_info_event".}
##
##  @brief Read a single line status change event from the chip.
##  @param chip GPIO chip object.
##  @return Newly read watch event object or NULL on error. The event must be
##          freed by the caller using ::gpiod_info_event_free.
##  @note If no events are pending, this function will block.
##

proc gpiod_chip_read_info_event*(chip: ptr gpiod_chip): ptr gpiod_info_event {.
    importc: "gpiod_chip_read_info_event".}
##
##  @brief Map a line's name to its offset within the chip.
##  @param chip GPIO chip object.
##  @param name Name of the GPIO line to map.
##  @return Offset of the line within the chip or -1 on error.
##  @note If a line with given name is not exposed by the chip, the function
##        sets errno to ENOENT.
##

proc gpiod_chip_get_line_offset_from_name*(chip: ptr gpiod_chip; name: cstring): cint {.
    importc: "gpiod_chip_get_line_offset_from_name".}
##
##  @brief Request a set of lines for exclusive usage.
##  @param chip GPIO chip object.
##  @param req_cfg Request config object. Can be NULL for default settings.
##  @param line_cfg Line config object.
##  @return New line request object or NULL if an error occurred. The request
##          must be released by the caller using ::gpiod_line_request_release.
##

proc gpiod_chip_request_lines*(chip: ptr gpiod_chip;
                              req_cfg: ptr gpiod_request_config;
                              line_cfg: ptr gpiod_line_config): ptr gpiod_line_request {.
    importc: "gpiod_chip_request_lines".}
##
##  @}
##
##  @defgroup chip_info Chip info
##  @{
##
##  Functions for retrieving kernel information about chips.
##
##  Line info object contains an immutable snapshot of a chip's status.
##
##  The chip info contains all the publicly available information about a
##  chip.
##
##  Some accessor methods return pointers. Those pointers refer to internal
##  fields. The lifetimes of those fields are tied to the lifetime of the
##  containing chip info object. Such pointers remain valid until
##  ::gpiod_chip_info_free is called on the containing chip info object. They
##  must not be freed by the caller.
##
##
##  @brief Free a chip info object and release all associated resources.
##  @param info GPIO chip info object to free.
##

proc gpiod_chip_info_free*(info: ptr gpiod_chip_info) {.
    importc: "gpiod_chip_info_free".}
##
##  @brief Get the name of the chip as represented in the kernel.
##  @param info GPIO chip info object.
##  @return Valid pointer to a human-readable string containing the chip name.
##          The string lifetime is tied to the chip info object so the pointer
##          must not be freed by the caller.
##

proc gpiod_chip_info_get_name*(info: ptr gpiod_chip_info): cstring {.
    importc: "gpiod_chip_info_get_name".}
##
##  @brief Get the label of the chip as represented in the kernel.
##  @param info GPIO chip info object.
##  @return Valid pointer to a human-readable string containing the chip label.
##          The string lifetime is tied to the chip info object so the pointer
##          must not be freed by the caller.
##

proc gpiod_chip_info_get_label*(info: ptr gpiod_chip_info): cstring {.
    importc: "gpiod_chip_info_get_label".}
##
##  @brief Get the number of lines exposed by the chip.
##  @param info GPIO chip info object.
##  @return Number of GPIO lines.
##

proc gpiod_chip_info_get_num_lines*(info: ptr gpiod_chip_info): csize_t {.
    importc: "gpiod_chip_info_get_num_lines".}
##
##  @}
##
##  @defgroup line_defs Line definitions
##  @{
##
##  These defines are used across the API.
##
##
##  @brief Logical line state.
##

type
  gpiod_line_value* = enum
    GPIOD_LINE_VALUE_ERROR = -1,   ## < Returned to indicate an error when reading the value.
    GPIOD_LINE_VALUE_INACTIVE = 0, ## < Line is logically inactive.
    GPIOD_LINE_VALUE_ACTIVE = 1    ## < Line is logically active.


##
##  @brief Direction settings.
##

type
  gpiod_line_direction* = enum
    GPIOD_LINE_DIRECTION_AS_IS = 1, ## < Request the line(s), but don't change direction.
    GPIOD_LINE_DIRECTION_INPUT,     ## < Direction is input - for reading the value of an externally driven
                                    ##    GPIO line.
    GPIOD_LINE_DIRECTION_OUTPUT     ## < Direction is output - for driving the GPIO line.


##
##  @brief Edge detection settings.
##

type
  gpiod_line_edge* = enum
    GPIOD_LINE_EDGE_NONE = 1, ## < Line edge detection is disabled.
    GPIOD_LINE_EDGE_RISING,   ## < Line detects rising edge events.
    GPIOD_LINE_EDGE_FALLING,  ## < Line detects falling edge events.
    GPIOD_LINE_EDGE_BOTH      ## < Line detects both rising and falling edge events.


##
##  @brief Internal bias settings.
##

type
  gpiod_line_bias* = enum
    GPIOD_LINE_BIAS_AS_IS = 1, ## < Don't change the bias setting when applying line config.
    GPIOD_LINE_BIAS_UNKNOWN,   ## < The internal bias state is unknown.
    GPIOD_LINE_BIAS_DISABLED,  ## < The internal bias is disabled.
    GPIOD_LINE_BIAS_PULL_UP,   ## < The internal pull-up bias is enabled.
    GPIOD_LINE_BIAS_PULL_DOWN  ## < The internal pull-down bias is enabled.


##
##  @brief Drive settings.
##

type
  gpiod_line_drive* = enum
    GPIOD_LINE_DRIVE_PUSH_PULL = 1, ## < Drive setting is push-pull.
    GPIOD_LINE_DRIVE_OPEN_DRAIN,    ## < Line output is open-drain.
    GPIOD_LINE_DRIVE_OPEN_SOURCE    ## < Line output is open-source.


##
##  @brief Clock settings.
##

type
  gpiod_line_clock* = enum
    GPIOD_LINE_CLOCK_MONOTONIC = 1, ## < Line uses the monotonic clock for edge event timestamps.
    GPIOD_LINE_CLOCK_REALTIME,      ## < Line uses the realtime clock for edge event timestamps.
    GPIOD_LINE_CLOCK_HTE            ## < Line uses the hardware timestamp engine for event timestamps.


##
##  @}
##
##  @defgroup line_info Line info
##  @{
##
##  Functions for retrieving kernel information about both requested and free
##  lines.
##
##  Line info object contains an immutable snapshot of a line's status.
##
##  The line info contains all the publicly available information about a
##  line, which does not include the line value. The line must be requested
##  to access the line value.
##
##  Some accessor methods return pointers. Those pointers refer to internal
##  fields. The lifetimes of those fields are tied to the lifetime of the
##  containing line info object. Such pointers remain valid until
##  ::gpiod_line_info_free is called on the containing line info object. They
##  must not be freed by the caller.
##
##
##  @brief Free a line info object and release all associated resources.
##  @param info GPIO line info object to free.
##

proc gpiod_line_info_free*(info: ptr gpiod_line_info) {.
    importc: "gpiod_line_info_free".}
##
##  @brief Copy a line info object.
##  @param info Line info to copy.
##  @return Copy of the line info or NULL on error. The returned object must
##          be freed by the caller using :gpiod_line_info_free.
##

proc gpiod_line_info_copy*(info: ptr gpiod_line_info): ptr gpiod_line_info {.
    importc: "gpiod_line_info_copy".}
##
##  @brief Get the offset of the line.
##  @param info GPIO line info object.
##  @return Offset of the line within the parent chip.
##
##  The offset uniquely identifies the line on the chip. The combination of the
##  chip and offset uniquely identifies the line within the system.
##

proc gpiod_line_info_get_offset*(info: ptr gpiod_line_info): cuint {.
    importc: "gpiod_line_info_get_offset".}
##
##  @brief Get the name of the line.
##  @param info GPIO line info object.
##  @return Name of the GPIO line as it is represented in the kernel.
##          This function returns a valid pointer to a null-terminated string
##          or NULL if the line is unnamed. The string lifetime is tied to the
##          line info object so the pointer must not be freed.
##

proc gpiod_line_info_get_name*(info: ptr gpiod_line_info): cstring {.
    importc: "gpiod_line_info_get_name".}
##
##  @brief Check if the line is in use.
##  @param info GPIO line object.
##  @return True if the line is in use, false otherwise.
##
##  The exact reason a line is busy cannot be determined from user space.
##  It may have been requested by another process or hogged by the kernel.
##  It only matters that the line is used and can't be requested until
##  released by the existing consumer.
##

proc gpiod_line_info_is_used*(info: ptr gpiod_line_info): bool {.
    importc: "gpiod_line_info_is_used".}
##
##  @brief Get the name of the consumer of the line.
##  @param info GPIO line info object.
##  @return Name of the GPIO consumer as it is represented in the kernel.
##         This function returns a valid pointer to a null-terminated string
##         or NULL if the consumer name is not set.
##         The string lifetime is tied to the line info object so the pointer
##         must not be freed.
##

proc gpiod_line_info_get_consumer*(info: ptr gpiod_line_info): cstring {.
    importc: "gpiod_line_info_get_consumer".}
##
##  @brief Get the direction setting of the line.
##  @param info GPIO line info object.
##  @return Returns ::GPIOD_LINE_DIRECTION_INPUT or
##         ::GPIOD_LINE_DIRECTION_OUTPUT.
##

proc gpiod_line_info_get_direction*(info: ptr gpiod_line_info): gpiod_line_direction {.
    importc: "gpiod_line_info_get_direction".}
##
##  @brief Get the edge detection setting of the line.
##  @param info GPIO line info object.
##  @return Returns ::GPIOD_LINE_EDGE_NONE, ::GPIOD_LINE_EDGE_RISING,
##         ::GPIOD_LINE_EDGE_FALLING or ::GPIOD_LINE_EDGE_BOTH.
##

proc gpiod_line_info_get_edge_detection*(info: ptr gpiod_line_info): gpiod_line_edge {.
    importc: "gpiod_line_info_get_edge_detection".}
##
##  @brief Get the bias setting of the line.
##  @param info GPIO line object.
##  @return Returns ::GPIOD_LINE_BIAS_PULL_UP, ::GPIOD_LINE_BIAS_PULL_DOWN,
##          ::GPIOD_LINE_BIAS_DISABLED or ::GPIOD_LINE_BIAS_UNKNOWN.
##

proc gpiod_line_info_get_bias*(info: ptr gpiod_line_info): gpiod_line_bias {.
    importc: "gpiod_line_info_get_bias".}
##
##  @brief Get the drive setting of the line.
##  @param info GPIO line info object.
##  @return Returns ::GPIOD_LINE_DRIVE_PUSH_PULL, ::GPIOD_LINE_DRIVE_OPEN_DRAIN
##          or ::GPIOD_LINE_DRIVE_OPEN_SOURCE.
##

proc gpiod_line_info_get_drive*(info: ptr gpiod_line_info): gpiod_line_drive {.
    importc: "gpiod_line_info_get_drive".}
##
##  @brief Check if the logical value of the line is inverted compared to the
##         physical.
##  @param info GPIO line object.
##  @return True if the line is "active-low", false otherwise.
##

proc gpiod_line_info_is_active_low*(info: ptr gpiod_line_info): bool {.
    importc: "gpiod_line_info_is_active_low".}
##
##  @brief Check if the line is debounced (either by hardware or by the kernel
##         software debouncer).
##  @param info GPIO line info object.
##  @return True if the line is debounced, false otherwise.
##

proc gpiod_line_info_is_debounced*(info: ptr gpiod_line_info): bool {.
    importc: "gpiod_line_info_is_debounced".}
##
##  @brief Get the debounce period of the line, in microseconds.
##  @param info GPIO line info object.
##  @return Debounce period in microseconds.
##          0 if the line is not debounced.
##

proc gpiod_line_info_get_debounce_period_us*(info: ptr gpiod_line_info): culong {.
    importc: "gpiod_line_info_get_debounce_period_us".}
##
##  @brief Get the event clock setting used for edge event timestamps for the
##         line.
##  @param info GPIO line info object.
##  @return Returns ::GPIOD_LINE_CLOCK_MONOTONIC, ::GPIOD_LINE_CLOCK_HTE or
##          ::GPIOD_LINE_CLOCK_REALTIME.
##

proc gpiod_line_info_get_event_clock*(info: ptr gpiod_line_info): gpiod_line_clock {.
    importc: "gpiod_line_info_get_event_clock".}
##
##  @}
##
##  @defgroup line_watch Line status watch events
##  @{
##
##  Accessors for the info event objects allowing to monitor changes in GPIO
##  line status.
##
##  Callers are notified about changes in a line's status due to GPIO uAPI
##  calls. Each info event contains information about the event itself
##  (timestamp, type) as well as a snapshot of line's status in the form
##  of a line-info object.
##
##
##  @brief Line status change event types.
##

type
  gpiod_info_event_type* = enum
    GPIOD_INFO_EVENT_LINE_REQUESTED = 1, ## < Line has been requested.
    GPIOD_INFO_EVENT_LINE_RELEASED,      ## < Previously requested line has been released.
    GPIOD_INFO_EVENT_LINE_CONFIG_CHANGED ## < Line configuration has changed.


##
##  @brief Free the info event object and release all associated resources.
##  @param event Info event to free.
##

proc gpiod_info_event_free*(event: ptr gpiod_info_event) {.
    importc: "gpiod_info_event_free".}
##
##  @brief Get the event type of the status change event.
##  @param event Line status watch event.
##  @return One of ::GPIOD_INFO_EVENT_LINE_REQUESTED,
##          ::GPIOD_INFO_EVENT_LINE_RELEASED or
##          ::GPIOD_INFO_EVENT_LINE_CONFIG_CHANGED.
##

proc gpiod_info_event_get_event_type*(event: ptr gpiod_info_event): gpiod_info_event_type {.
    importc: "gpiod_info_event_get_event_type".}
##
##  @brief Get the timestamp of the event.
##  @param event Line status watch event.
##  @return Timestamp in nanoseconds, read from the monotonic clock.
##

proc gpiod_info_event_get_timestamp_ns*(event: ptr gpiod_info_event): uint64_t {.
    importc: "gpiod_info_event_get_timestamp_ns".}
##
##  @brief Get the snapshot of line-info associated with the event.
##  @param event Line info event object.
##  @return Returns a pointer to the line-info object associated with the event.
##          The object lifetime is tied to the event object, so the pointer must
##          be not be freed by the caller.
##  @warning Thread-safety:
##           Since the line-info object is tied to the event, different threads
##           may not operate on the event and line-info at the same time. The
##           line-info can be copied using ::gpiod_line_info_copy in order to
##           create a standalone object - which then may safely be used from a
##           different thread concurrently.
##

proc gpiod_info_event_get_line_info*(event: ptr gpiod_info_event): ptr gpiod_line_info {.
    importc: "gpiod_info_event_get_line_info".}
##
##  @}
##
##  @defgroup line_settings Line settings objects
##  @{
##
##  Functions for manipulating line settings objects.
##
##  Line settings object contains a set of line properties that can be used
##  when requesting lines or reconfiguring an existing request.
##
##  Mutators in general can only fail if the new property value is invalid. The
##  return values can be safely ignored - the object remains valid even after
##  a mutator fails and simply uses the sane default appropriate for given
##  property.
##
##
##  @brief Create a new line settings object.
##  @return New line settings object or NULL on error. The returned object must
##          be freed by the caller using ::gpiod_line_settings_free.
##

proc gpiod_line_settings_new*(): ptr gpiod_line_settings {.
    importc: "gpiod_line_settings_new".}
##
##  @brief Free the line settings object and release all associated resources.
##  @param settings Line settings object.
##

proc gpiod_line_settings_free*(settings: ptr gpiod_line_settings) {.
    importc: "gpiod_line_settings_free".}
##
##  @brief Reset the line settings object to its default values.
##  @param settings Line settings object.
##

proc gpiod_line_settings_reset*(settings: ptr gpiod_line_settings) {.
    importc: "gpiod_line_settings_reset".}
##
##  @brief Copy the line settings object.
##  @param settings Line settings object to copy.
##  @return New line settings object that must be freed using
##          ::gpiod_line_settings_free or NULL on failure.
##

proc gpiod_line_settings_copy*(settings: ptr gpiod_line_settings): ptr gpiod_line_settings {.
    importc: "gpiod_line_settings_copy".}
##
##  @brief Set direction.
##  @param settings Line settings object.
##  @param direction New direction.
##  @return 0 on success, -1 on error.
##

proc gpiod_line_settings_set_direction*(settings: ptr gpiod_line_settings;
                                       direction: gpiod_line_direction): cint {.
    importc: "gpiod_line_settings_set_direction".}
##
##  @brief Get direction.
##  @param settings Line settings object.
##  @return Current direction.
##

proc gpiod_line_settings_get_direction*(settings: ptr gpiod_line_settings): gpiod_line_direction {.
    importc: "gpiod_line_settings_get_direction".}
##
##  @brief Set edge detection.
##  @param settings Line settings object.
##  @param edge New edge detection setting.
##  @return 0 on success, -1 on failure.
##

proc gpiod_line_settings_set_edge_detection*(settings: ptr gpiod_line_settings;
    edge: gpiod_line_edge): cint {.importc: "gpiod_line_settings_set_edge_detection".}
##
##  @brief Get edge detection.
##  @param settings Line settings object.
##  @return Current edge detection setting.
##

proc gpiod_line_settings_get_edge_detection*(settings: ptr gpiod_line_settings): gpiod_line_edge {.
    importc: "gpiod_line_settings_get_edge_detection".}
##
##  @brief Set bias.
##  @param settings Line settings object.
##  @param bias New bias.
##  @return 0 on success, -1 on failure.
##

proc gpiod_line_settings_set_bias*(settings: ptr gpiod_line_settings;
                                  bias: gpiod_line_bias): cint {.
    importc: "gpiod_line_settings_set_bias".}
##
##  @brief Get bias.
##  @param settings Line settings object.
##  @return Current bias setting.
##

proc gpiod_line_settings_get_bias*(settings: ptr gpiod_line_settings): gpiod_line_bias {.
    importc: "gpiod_line_settings_get_bias".}
##
##  @brief Set drive.
##  @param settings Line settings object.
##  @param drive New drive setting.
##  @return 0 on success, -1 on failure.
##

proc gpiod_line_settings_set_drive*(settings: ptr gpiod_line_settings;
                                   drive: gpiod_line_drive): cint {.
    importc: "gpiod_line_settings_set_drive".}
##
##  @brief Get drive.
##  @param settings Line settings object.
##  @return Current drive setting.
##

proc gpiod_line_settings_get_drive*(settings: ptr gpiod_line_settings): gpiod_line_drive {.
    importc: "gpiod_line_settings_get_drive".}
##
##  @brief Set active-low setting.
##  @param settings Line settings object.
##  @param active_low New active-low setting.
##

proc gpiod_line_settings_set_active_low*(settings: ptr gpiod_line_settings;
                                        active_low: bool) {.
    importc: "gpiod_line_settings_set_active_low".}
##
##  @brief Get active-low setting.
##  @param settings Line settings object.
##  @return True if active-low is enabled, false otherwise.
##

proc gpiod_line_settings_get_active_low*(settings: ptr gpiod_line_settings): bool {.
    importc: "gpiod_line_settings_get_active_low".}
##
##  @brief Set debounce period.
##  @param settings Line settings object.
##  @param period New debounce period in microseconds.
##

proc gpiod_line_settings_set_debounce_period_us*(
    settings: ptr gpiod_line_settings; period: culong) {.
    importc: "gpiod_line_settings_set_debounce_period_us".}
##
##  @brief Get debounce period.
##  @param settings Line settings object.
##  @return Current debounce period in microseconds.
##

proc gpiod_line_settings_get_debounce_period_us*(
    settings: ptr gpiod_line_settings): culong {.
    importc: "gpiod_line_settings_get_debounce_period_us".}
##
##  @brief Set event clock.
##  @param settings Line settings object.
##  @param event_clock New event clock.
##  @return 0 on success, -1 on failure.
##

proc gpiod_line_settings_set_event_clock*(settings: ptr gpiod_line_settings;
    event_clock: gpiod_line_clock): cint {.importc: "gpiod_line_settings_set_event_clock".}
##
##  @brief Get event clock setting.
##  @param settings Line settings object.
##  @return Current event clock setting.
##

proc gpiod_line_settings_get_event_clock*(settings: ptr gpiod_line_settings): gpiod_line_clock {.
    importc: "gpiod_line_settings_get_event_clock".}
##
##  @brief Set the output value.
##  @param settings Line settings object.
##  @param value New output value.
##  @return 0 on success, -1 on failure.
##

proc gpiod_line_settings_set_output_value*(settings: ptr gpiod_line_settings;
    value: gpiod_line_value): cint {.importc: "gpiod_line_settings_set_output_value".}
##
##  @brief Get the output value.
##  @param settings Line settings object.
##  @return Current output value.
##

proc gpiod_line_settings_get_output_value*(settings: ptr gpiod_line_settings): gpiod_line_value {.
    importc: "gpiod_line_settings_get_output_value".}
##
##  @}
##
##  @defgroup line_config Line configuration objects
##  @{
##
##  Functions for manipulating line configuration objects.
##
##  The line-config object contains the configuration for lines that can be
##  used in two cases:
##   - when making a line request
##   - when reconfiguring a set of already requested lines.
##
##  A new line-config object is empty. Using it in a request will lead to an
##  error. In order to a line-config to become useful, it needs to be assigned
##  at least one offset-to-settings mapping by calling
##  ::gpiod_line_config_add_line_settings.
##
##  When calling ::gpiod_chip_request_lines, the library will request all
##  offsets that were assigned settings in the order that they were assigned.
##  If any of the offsets was duplicated, the last one will take precedence.
##
##
##  @brief Create a new line config object.
##  @return New line config object or NULL on error. The returned object must
##          be freed by the caller using ::gpiod_line_config_free.
##

proc gpiod_line_config_new*(): ptr gpiod_line_config {.
    importc: "gpiod_line_config_new".}
##
##  @brief Free the line config object and release all associated resources.
##  @param config Line config object to free.
##

proc gpiod_line_config_free*(config: ptr gpiod_line_config) {.
    importc: "gpiod_line_config_free".}
##
##  @brief Reset the line config object.
##  @param config Line config object to free.
##
##  Resets the entire configuration stored in the object. This is useful if
##  the user wants to reuse the object without reallocating it.
##

proc gpiod_line_config_reset*(config: ptr gpiod_line_config) {.
    importc: "gpiod_line_config_reset".}
##
##  @brief Add line settings for a set of offsets.
##  @param config Line config object.
##  @param offsets Array of offsets for which to apply the settings.
##  @param num_offsets Number of offsets stored in the offsets array.
##  @param settings Line settings to apply.
##  @return 0 on success, -1 on failure.
##

proc gpiod_line_config_add_line_settings*(config: ptr gpiod_line_config;
    offsets: ptr cuint; num_offsets: csize_t; settings: ptr gpiod_line_settings): cint {.
    importc: "gpiod_line_config_add_line_settings".}
##
##  @brief Get line settings for offset.
##  @param config Line config object.
##  @param offset Offset for which to get line settings.
##  @return New line settings object (must be freed by the caller) or NULL on
##          error.
##

proc gpiod_line_config_get_line_settings*(config: ptr gpiod_line_config;
    offset: cuint): ptr gpiod_line_settings {.
    importc: "gpiod_line_config_get_line_settings".}
##
##  @brief Set output values for a number of lines.
##  @param config Line config object.
##  @param values Buffer containing the output values.
##  @param num_values Number of values in the buffer.
##  @return 0 on success, -1 on error.
##
##  This is a helper that allows users to set multiple (potentially different)
##  output values at once while using the same line settings object. Instead of
##  modifying the output value in the settings object and calling
##  ::gpiod_line_config_add_line_settings multiple times, we can specify the
##  settings, add them for a set of offsets and then call this function to
##  set the output values.
##
##  Values set by this function override whatever values were specified in the
##  regular line settings.
##
##  Each value must be associated with the line identified by the corresponding
##  entry in the offset array filled by
##  ::gpiod_line_request_get_requested_offsets.
##

proc gpiod_line_config_set_output_values*(config: ptr gpiod_line_config;
    values: ptr gpiod_line_value; num_values: csize_t): cint {.
    importc: "gpiod_line_config_set_output_values".}
##
##  @brief Get the number of configured line offsets.
##  @param config Line config object.
##  @return Number of offsets for which line settings have been added.
##

proc gpiod_line_config_get_num_configured_offsets*(config: ptr gpiod_line_config): csize_t {.
    importc: "gpiod_line_config_get_num_configured_offsets".}
##
##  @brief Get configured offsets.
##  @param config Line config object.
##  @param offsets Array to store offsets.
##  @param max_offsets Number of offsets that can be stored in the offsets array.
##  @return Number of offsets stored in the offsets array.
##
##  If max_offsets is lower than the number of lines actually requested (this
##  value can be retrieved using ::gpiod_line_config_get_num_configured_offsets),
##  then only up to max_lines offsets will be stored in offsets.
##

proc gpiod_line_config_get_configured_offsets*(config: ptr gpiod_line_config;
    offsets: ptr cuint; max_offsets: csize_t): csize_t {.
    importc: "gpiod_line_config_get_configured_offsets".}
##
##  @}
##
##  @defgroup request_config Request configuration objects
##  @{
##
##  Functions for manipulating request configuration objects.
##
##  Request config objects are used to pass a set of options to the kernel at
##  the time of the line request. The mutators don't return error values. If the
##  values are invalid, in general they are silently adjusted to acceptable
##  ranges.
##
##
##  @brief Create a new request config object.
##  @return New request config object or NULL on error. The returned object must
##          be freed by the caller using ::gpiod_request_config_free.
##

proc gpiod_request_config_new*(): ptr gpiod_request_config {.
    importc: "gpiod_request_config_new".}
##
##  @brief Free the request config object and release all associated resources.
##  @param config Line config object.
##

proc gpiod_request_config_free*(config: ptr gpiod_request_config) {.
    importc: "gpiod_request_config_free".}
##
##  @brief Set the consumer name for the request.
##  @param config Request config object.
##  @param consumer Consumer name.
##  @note If the consumer string is too long, it will be truncated to the max
##        accepted length.
##

proc gpiod_request_config_set_consumer*(config: ptr gpiod_request_config;
                                       consumer: cstring) {.
    importc: "gpiod_request_config_set_consumer".}
##
##  @brief Get the consumer name configured in the request config.
##  @param config Request config object.
##  @return Consumer name stored in the request config.
##

proc gpiod_request_config_get_consumer*(config: ptr gpiod_request_config): cstring {.
    importc: "gpiod_request_config_get_consumer".}
##
##  @brief Set the size of the kernel event buffer for the request.
##  @param config Request config object.
##  @param event_buffer_size New event buffer size.
##  @note The kernel may adjust the value if it's too high. If set to 0, the
##        default value will be used.
##  @note The kernel buffer is distinct from and independent of the user space
##        buffer (::gpiod_edge_event_buffer_new).
##

proc gpiod_request_config_set_event_buffer_size*(
    config: ptr gpiod_request_config; event_buffer_size: csize_t) {.
    importc: "gpiod_request_config_set_event_buffer_size".}
##
##  @brief Get the edge event buffer size for the request config.
##  @param config Request config object.
##  @return Edge event buffer size setting from the request config.
##

proc gpiod_request_config_get_event_buffer_size*(config: ptr gpiod_request_config): csize_t {.
    importc: "gpiod_request_config_get_event_buffer_size".}
##
##  @}
##
##  @defgroup line_request Line request operations
##  @{
##
##  Functions allowing interactions with requested lines.
##
##
##  @brief Release the requested lines and free all associated resources.
##  @param request Line request object to release.
##

proc gpiod_line_request_release*(request: ptr gpiod_line_request) {.
    importc: "gpiod_line_request_release".}
##
##  @brief Get the name of the chip this request was made on.
##  @param request Line request object.
##  @return Name the GPIO chip device. The returned pointer is valid for the
##  lifetime of the request object and must not be freed by the caller.
##

proc gpiod_line_request_get_chip_name*(request: ptr gpiod_line_request): cstring {.
    importc: "gpiod_line_request_get_chip_name".}
##
##  @brief Get the number of lines in the request.
##  @param request Line request object.
##  @return Number of requested lines.
##

proc gpiod_line_request_get_num_requested_lines*(request: ptr gpiod_line_request): csize_t {.
    importc: "gpiod_line_request_get_num_requested_lines".}
##
##  @brief Get the offsets of the lines in the request.
##  @param request Line request object.
##  @param offsets Array to store offsets.
##  @param max_offsets Number of offsets that can be stored in the offsets array.
##  @return Number of offsets stored in the offsets array.
##
##  If max_offsets is lower than the number of lines actually requested (this
##  value can be retrieved using ::gpiod_line_request_get_num_requested_lines),
##  then only up to max_lines offsets will be stored in offsets.
##

proc gpiod_line_request_get_requested_offsets*(request: ptr gpiod_line_request;
    offsets: ptr cuint; max_offsets: csize_t): csize_t {.
    importc: "gpiod_line_request_get_requested_offsets".}
##
##  @brief Get the value of a single requested line.
##  @param request Line request object.
##  @param offset The offset of the line of which the value should be read.
##  @return Returns 1 or 0 on success and -1 on error.
##

proc gpiod_line_request_get_value*(request: ptr gpiod_line_request; offset: cuint): gpiod_line_value {.
    importc: "gpiod_line_request_get_value".}
##
##  @brief Get the values of a subset of requested lines.
##  @param request GPIO line request.
##  @param num_values Number of lines for which to read values.
##  @param offsets Array of offsets identifying the subset of requested lines
##                 from which to read values.
##  @param values Array in which the values will be stored. Must be sized
##                to hold \p num_values entries. Each value is associated with
##                the line identified by the corresponding entry in \p offsets.
##  @return 0 on success, -1 on failure.
##

proc gpiod_line_request_get_values_subset*(request: ptr gpiod_line_request;
    num_values: csize_t; offsets: ptr cuint; values: ptr gpiod_line_value): cint {.
    importc: "gpiod_line_request_get_values_subset".}
##
##  @brief Get the values of all requested lines.
##  @param request GPIO line request.
##  @param values Array in which the values will be stored. Must be sized to
##                hold the number of lines filled by
##                ::gpiod_line_request_get_num_requested_lines.
##                Each value is associated with the line identified by the
##                corresponding entry in the offset array filled by
##                ::gpiod_line_request_get_requested_offsets.
##  @return 0 on success, -1 on failure.
##

proc gpiod_line_request_get_values*(request: ptr gpiod_line_request;
                                   values: ptr gpiod_line_value): cint {.
    importc: "gpiod_line_request_get_values".}
##
##  @brief Set the value of a single requested line.
##  @param request Line request object.
##  @param offset The offset of the line for which the value should be set.
##  @param value Value to set.
##  @return 0 on success, -1 on failure.
##

proc gpiod_line_request_set_value*(request: ptr gpiod_line_request; offset: cuint;
                                  value: gpiod_line_value): cint {.
    importc: "gpiod_line_request_set_value".}
##
##  @brief Set the values of a subset of requested lines.
##  @param request GPIO line request.
##  @param num_values Number of lines for which to set values.
##  @param offsets Array of offsets, containing the number of entries specified
##                 by \p num_values, identifying the requested lines for
##                 which to set values.
##  @param values Array of values to set, containing the number of entries
##                specified by \p num_values. Each value is associated with the
##                line identified by the corresponding entry in \p offsets.
##  @return 0 on success, -1 on failure.
##

proc gpiod_line_request_set_values_subset*(request: ptr gpiod_line_request;
    num_values: csize_t; offsets: ptr cuint; values: ptr gpiod_line_value): cint {.
    importc: "gpiod_line_request_set_values_subset".}
##
##  @brief Set the values of all lines associated with a request.
##  @param request GPIO line request.
##  @param values Array containing the values to set. Must be sized to
##                contain the number of lines filled by
##                ::gpiod_line_request_get_num_requested_lines.
##                Each value is associated with the line identified by the
##                corresponding entry in the offset array filled by
##                ::gpiod_line_request_get_requested_offsets.
##  @return 0 on success, -1 on failure.
##

proc gpiod_line_request_set_values*(request: ptr gpiod_line_request;
                                   values: ptr gpiod_line_value): cint {.
    importc: "gpiod_line_request_set_values".}
##
##  @brief Update the configuration of lines associated with a line request.
##  @param request GPIO line request.
##  @param config New line config to apply.
##  @return 0 on success, -1 on failure.
##  @note The new line configuration completely replaces the old.
##  @note Any requested lines without overrides are configured to the requested
##        defaults.
##  @note Any configured overrides for lines that have not been requested
##        are silently ignored.
##

proc gpiod_line_request_reconfigure_lines*(request: ptr gpiod_line_request;
    config: ptr gpiod_line_config): cint {.importc: "gpiod_line_request_reconfigure_lines".}
##
##  @brief Get the file descriptor associated with a line request.
##  @param request GPIO line request.
##  @return The file descriptor associated with the request.
##          This function never fails.
##          The returned file descriptor must not be closed by the caller.
##          Call ::gpiod_line_request_release to close the file.
##

proc gpiod_line_request_get_fd*(request: ptr gpiod_line_request): cint {.
    importc: "gpiod_line_request_get_fd".}
##
##  @brief Wait for edge events on any of the requested lines.
##  @param request GPIO line request.
##  @param timeout_ns Wait time limit in nanoseconds. If set to 0, the function
##                    returns immediatelly. If set to a negative number, the
##                    function blocks indefinitely until an event becomes
##                    available.
##  @return 0 if wait timed out, -1 if an error occurred, 1 if an event is
##          pending.
##
##  Lines must have edge detection set for edge events to be emitted.
##  By default edge detection is disabled.
##

proc gpiod_line_request_wait_edge_events*(request: ptr gpiod_line_request;
    timeout_ns: int64_t): cint {.importc: "gpiod_line_request_wait_edge_events".}
##
##  @brief Read a number of edge events from a line request.
##  @param request GPIO line request.
##  @param buffer Edge event buffer, sized to hold at least \p max_events.
##  @param max_events Maximum number of events to read.
##  @return On success returns the number of events read from the file
##          descriptor, on failure return -1.
##  @note This function will block if no event was queued for the line request.
##  @note Any exising events in the buffer are overwritten. This is not an
##        append operation.
##

proc gpiod_line_request_read_edge_events*(request: ptr gpiod_line_request;
    buffer: ptr gpiod_edge_event_buffer; max_events: csize_t): cint {.
    importc: "gpiod_line_request_read_edge_events".}
##
##  @}
##
##  @defgroup edge_event Line edge events handling
##  @{
##
##  Functions and data types for handling edge events.
##
##  An edge event object contains information about a single line edge event.
##  It contains the event type, timestamp and the offset of the line on which
##  the event occurred as well as two sequence numbers (global for all lines
##  in the associated request and local for this line only).
##
##  Edge events are stored into an edge-event buffer object to improve
##  performance and to limit the number of memory allocations when a large
##  number of events are being read.
##
##
##  @brief Event types.
##

type
  gpiod_edge_event_type* = enum
    GPIOD_EDGE_EVENT_RISING_EDGE = 1, ## < Rising edge event.
    GPIOD_EDGE_EVENT_FALLING_EDGE     ## < Falling edge event.


##
##  @brief Free the edge event object.
##  @param event Edge event object to free.
##

proc gpiod_edge_event_free*(event: ptr gpiod_edge_event) {.
    importc: "gpiod_edge_event_free".}
##
##  @brief Copy the edge event object.
##  @param event Edge event to copy.
##  @return Copy of the edge event or NULL on error. The returned object must
##          be freed by the caller using ::gpiod_edge_event_free.
##

proc gpiod_edge_event_copy*(event: ptr gpiod_edge_event): ptr gpiod_edge_event {.
    importc: "gpiod_edge_event_copy".}
##
##  @brief Get the event type.
##  @param event GPIO edge event.
##  @return The event type (::GPIOD_EDGE_EVENT_RISING_EDGE or
##          ::GPIOD_EDGE_EVENT_FALLING_EDGE).
##

proc gpiod_edge_event_get_event_type*(event: ptr gpiod_edge_event): gpiod_edge_event_type {.
    importc: "gpiod_edge_event_get_event_type".}
##
##  @brief Get the timestamp of the event.
##  @param event GPIO edge event.
##  @return Timestamp in nanoseconds.
##  @note The source clock for the timestamp depends on the event_clock
##        setting for the line.
##

proc gpiod_edge_event_get_timestamp_ns*(event: ptr gpiod_edge_event): uint64_t {.
    importc: "gpiod_edge_event_get_timestamp_ns".}
##
##  @brief Get the offset of the line which triggered the event.
##  @param event GPIO edge event.
##  @return Line offset.
##

proc gpiod_edge_event_get_line_offset*(event: ptr gpiod_edge_event): cuint {.
    importc: "gpiod_edge_event_get_line_offset".}
##
##  @brief Get the global sequence number of the event.
##  @param event GPIO edge event.
##  @return Sequence number of the event in the series of events for all lines
##          in the associated line request.
##

proc gpiod_edge_event_get_global_seqno*(event: ptr gpiod_edge_event): culong {.
    importc: "gpiod_edge_event_get_global_seqno".}
##
##  @brief Get the event sequence number specific to the line.
##  @param event GPIO edge event.
##  @return Sequence number of the event in the series of events only for this
##          line within the lifetime of the associated line request.
##

proc gpiod_edge_event_get_line_seqno*(event: ptr gpiod_edge_event): culong {.
    importc: "gpiod_edge_event_get_line_seqno".}
##
##  @brief Create a new edge event buffer.
##  @param capacity Number of events the buffer can store (min = 1, max = 1024).
##  @return New edge event buffer or NULL on error.
##  @note If capacity equals 0, it will be set to a default value of 64. If
##        capacity is larger than 1024, it will be limited to 1024.
##  @note The user space buffer is independent of the kernel buffer
##        (::gpiod_request_config_set_event_buffer_size). As the user space
##        buffer is filled from the kernel buffer, there is no benefit making
##        the user space buffer larger than the kernel buffer.
##        The default kernel buffer size for each request is (16 * num_lines).
##

proc gpiod_edge_event_buffer_new*(capacity: csize_t): ptr gpiod_edge_event_buffer {.
    importc: "gpiod_edge_event_buffer_new".}
##
##  @brief Get the capacity (the max number of events that can be stored) of
##         the event buffer.
##  @param buffer Edge event buffer.
##  @return The capacity of the buffer.
##

proc gpiod_edge_event_buffer_get_capacity*(buffer: ptr gpiod_edge_event_buffer): csize_t {.
    importc: "gpiod_edge_event_buffer_get_capacity".}
##
##  @brief Free the edge event buffer and release all associated resources.
##  @param buffer Edge event buffer to free.
##

proc gpiod_edge_event_buffer_free*(buffer: ptr gpiod_edge_event_buffer) {.
    importc: "gpiod_edge_event_buffer_free".}
##
##  @brief Get an event stored in the buffer.
##  @param buffer Edge event buffer.
##  @param index Index of the event in the buffer.
##  @return Pointer to an event stored in the buffer. The lifetime of the
##          event is tied to the buffer object. Users must not free the event
##          returned by this function.
##  @warning Thread-safety:
##           Since events are tied to the buffer instance, different threads
##           may not operate on the buffer and any associated events at the same
##           time. Events can be copied using ::gpiod_edge_event_copy in order
##           to create a standalone objects - which each may safely be used from
##           a different thread concurrently.
##

proc gpiod_edge_event_buffer_get_event*(buffer: ptr gpiod_edge_event_buffer;
                                       index: culong): ptr gpiod_edge_event {.
    importc: "gpiod_edge_event_buffer_get_event".}
##
##  @brief Get the number of events a buffer has stored.
##  @param buffer Edge event buffer.
##  @return Number of events stored in the buffer.
##

proc gpiod_edge_event_buffer_get_num_events*(buffer: ptr gpiod_edge_event_buffer): csize_t {.
    importc: "gpiod_edge_event_buffer_get_num_events".}
##
##  @}
##
##  @defgroup misc Stuff that didn't fit anywhere else
##  @{
##
##  Various libgpiod-related functions.
##
##
##  @brief Check if the file pointed to by path is a GPIO chip character device.
##  @param path Path to check.
##  @return True if the file exists and is either a GPIO chip character device
##          or a symbolic link to one.
##

proc gpiod_is_gpiochip_device*(path: cstring): bool {.
    importc: "gpiod_is_gpiochip_device".}
##
##  @brief Get the API version of the library as a human-readable string.
##  @return A valid pointer to a human-readable string containing the library
##          version. The pointer is valid for the lifetime of the program and
##          must not be freed by the caller.
##

proc gpiod_api_version*(): cstring {.importc: "gpiod_api_version".}
##
##  @}
##
