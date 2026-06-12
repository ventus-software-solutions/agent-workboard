export function buildUpdateTaskStatusPatch(input) {
  const patch = { status: input.status };
  if (input.completion !== undefined) {
    patch.completion = input.completion;
  }
  return patch;
}
