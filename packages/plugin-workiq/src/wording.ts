import type {
  ConnectorErrorWording,
  ControllerWording,
} from "@stuffbucket/maximal-connector-kit"

import { TERMS_URL, WORKIQ_CLIENT_ID } from "./manifest"

const APP = `the Work IQ app (${WORKIQ_CLIENT_ID})`

/** Work IQ wording for sign-in blocks, entitlement and policy failures. */
export const WORKIQ_ERRORS: ConnectorErrorWording = {
  adminHint: `A Microsoft Entra admin can check ${APP} under Enterprise applications: admin consent, user assignment and Conditional Access.`,
  messages: {
    "consent-needed": `Your organization has not approved Work IQ. A Microsoft Entra admin must grant tenant-wide admin consent to ${APP}.`,
    "not-assigned": `Your account is not assigned to ${APP}. Ask your Microsoft Entra admin to assign you.`,
    "app-disabled": `${APP.replace("the", "The")} is disabled or not available in your organization's Microsoft Entra tenant.`,
    "license-needed":
      "Your account is not licensed for Work IQ. Ask your Microsoft 365 admin for a license that includes Work IQ (Microsoft 365 Copilot), then choose Try again.",
    "not-entitled":
      "Your organization hasn't enabled Work IQ for this account. You stay signed in; choose Try again once your Microsoft 365 admin has enabled it.",
    "policy-denied":
      "Your organization's Work IQ policy doesn't allow this request.",
  },
}

/** Work IQ wording for the terms step. */
export const WORKIQ_WORDING: Pick<
  ControllerWording,
  "termsSummary" | "termsDetail"
> = {
  termsSummary: "Accept the Microsoft Work IQ terms to continue",
  termsDetail: `Work IQ is a Microsoft service that answers questions from your Microsoft 365 data. Review its terms at ${TERMS_URL} before you continue.`,
}
