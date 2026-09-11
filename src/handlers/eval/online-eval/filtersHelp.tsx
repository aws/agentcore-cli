export const filtersHelp = `(JSON: list of objects)
Narrows which sampled traces are evaluated. A trace must match every filter in
the list. Omit it to evaluate every sampled trace.

Accepts inline JSON, file://<path>, or - to read stdin.

JSON syntax:
  [
    {
      "key": "string",       // [required] trace field to filter on
      "operator": "Equals" | "NotEquals" | "Contains" | "NotContains"
                | "GreaterThan" | "GreaterThanOrEqual"
                | "LessThan" | "LessThanOrEqual",   // [required]
      "value": {                                    // [required] exactly one key
        "stringValue": "string",
        "doubleValue": number,
        "booleanValue": true | false
      }
    },
    ...
  ]

Example:
  --filters '[{"key":"attributes.customer_tier","operator":"Equals","value":{"stringValue":"enterprise"}}]'

  --filters file://filters.json`;
