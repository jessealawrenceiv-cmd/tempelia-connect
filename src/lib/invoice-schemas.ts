import { z } from "zod";

/** Shared zod shapes for the invoice server functions (kept out of the
 * server-fn module so bundle splitting cannot strip them). */
export const invoiceLineItemSchema = z.object({
  label: z.string().default(""),
  amount: z.coerce.number(),
});

export const invoiceSaveSchema = z.object({
  invoiceId: z.string().uuid(),
  customer_first_name: z.string().trim().min(1),
  customer_last_name: z.string().trim().nullable().optional(),
  customer_business_name: z.string().trim().nullable().optional(),
  customer_phone: z.string().trim().min(1),
  customer_email: z.string().trim().nullable().optional(),
  job_site_address: z.string().trim().min(1),
  line_items: z.array(invoiceLineItemSchema).min(1),
  tax_rate: z.coerce.number().min(0),
});
