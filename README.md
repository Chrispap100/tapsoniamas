# Τα Ψώνια μας

Λειτουργική mobile-first PWA για καθημερινή λίστα αγορών.

## Τρέχουσα έκδοση

Η εφαρμογή ανοίγει απευθείας ως static site, χωρίς build step ή npm dependencies.

Υλοποιούνται ήδη:
- γρήγορη προσθήκη και smart quantity parsing
- duplicate quantity merge
- αγορασμένα / επαναφορά
- soft delete / πρόσφατα διαγραμμένα
- ποσότητα, μονάδα, κατηγορία, κατάστημα, σημείωση, προτεραιότητα
- αναζήτηση
- ιστορικό
- light / dark / system theme
- offline local persistence
- PWA manifest + service worker + install prompt
- mobile-first responsive UI

## Deployment

Για Render χρησιμοποίησε Static Site με publish directory το repository root και χωρίς build command.

## Επόμενο backend βήμα

Για πραγματικό κοινό sync δύο χρηστών, login και realtime απαιτείται Supabase project. Δεν πρέπει να μπει service-role secret στον browser ή στο repository. Το επόμενο βήμα είναι Supabase Auth + households + memberships + shopping_items + RLS + realtime.
