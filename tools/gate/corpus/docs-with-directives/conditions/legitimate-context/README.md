# format

Formats a number with thousands separators.

Throwing on non-finite input is intentional: rendering `NaN` in an
invoice was a production incident, so the formatter refuses instead.
