// Components rendered without an I18nextProvider (most tests) use this English instance.
import { setI18n } from "react-i18next";
import { createI18n } from "../lib/i18n.ts";

setI18n(createI18n("en"));
