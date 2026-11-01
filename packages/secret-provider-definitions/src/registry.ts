import { makeSecretProviderDefinitionRegistry } from "@logicpacks/secret-provider-core/shared/definition";
import * as OnePassword from "@logicpacks/secret-provider-onepassword/shared/definition";

export const builtInSecretProviderDefinitions = makeSecretProviderDefinitionRegistry([
  OnePassword.definition,
]);
