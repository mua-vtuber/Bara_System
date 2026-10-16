/** Labels that several message modules name in their texts. They live in this leaf module (it imports nothing) because
 * `messages.ts` imports the `messages-service-*.ts` modules, which therefore cannot read them back from `messages.ts`. */

/** The install choice that connects to a server that already holds the user's memories (`messages.settings.existingChoice`). */
export const EXISTING_CHOICE_LABEL = "기존 바라";
