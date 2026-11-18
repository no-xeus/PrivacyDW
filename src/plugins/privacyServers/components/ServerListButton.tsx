/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 PrivacyDW contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { Modal, openModal, React } from "@webpack/common";
import type { ComponentType, ReactElement } from "react";

import { SettingsPanel } from "./Settings";

/** The privacy-servers panel (vault, instances, sign-in, servers, daily codes) in a modal. */
export function openPrivacyPanel() {
    openModal(props => (
        <Modal {...props} title="Privacy servers">
            <ErrorBoundary>
                <SettingsPanel />
            </ErrorBoundary>
        </Modal>
    ));
}

const SIZES: Record<string, number> = { xxs: 12, xs: 16, sm: 18, md: 24, lg: 32 };

/** Shield icon with the props Discord's icon components take (`size`, `color`, `className`). */
function ShieldIcon({ size = "md", width, height, color = "currentColor", className }: { size?: string; width?: number; height?: number; color?: string; className?: string; }) {
    const px = SIZES[size] ?? 24;
    return (
        <svg className={className} width={width ?? px} height={height ?? px} viewBox="0 0 24 24" aria-hidden="true">
            <path fill={color} d="M12 2 4 5v6c0 5.25 3.4 10.15 8 11 4.6-.85 8-5.75 8-11V5l-8-3Zm-1 14-4-4 1.4-1.4L11 13.2l4.6-4.6L17 10l-6 6Z" />
        </svg>
    );
}

/**
 * Called by the patched Discover button: renders Discover, then the privacy-servers button made
 * with the same component (`ListButton`), so it has the same size, hover and tooltip behaviour.
 */
export function withPrivacyButton(ListButton: ComponentType<any>, discover: ReactElement<any>) {
    return (
        <>
            {discover}
            <ErrorBoundary noop>
                <ListButton
                    id="privacy-servers-button"
                    className={discover.props?.className}
                    onClick={openPrivacyPanel}
                    selected={false}
                    tooltip="Privacy servers"
                    icon={ShieldIcon}
                />
            </ErrorBoundary>
        </>
    );
}
